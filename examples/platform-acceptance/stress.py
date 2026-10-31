#!/usr/bin/env python3
"""Bounded stress run against one prepared, opened acceptance instance.

Every job is one dispatch through tools/shared_stata.py with its own receipt;
nothing is retried. Correctness invariants decide the verdict. Resource
readings (backend memory, temp-directory bytes) are recorded as deltas only.
Synthetic data only: no research data, no reset, no Stop.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import uuid

# A self-contained agent job. It restores the caller's data so repeated jobs
# leave the shared session as they found it.
JOB = ("preserve\nclear\nset obs 200\ngenerate double x = _n\n"
       "generate double y = 3*x + 2\nquietly regress y x\n"
       "assert abs(_b[x] - 3) < 1e-8\nrestore\n"
       'display as text "WB_STRESS_JOB_OK"')
GATE_ZERO = ("doubleReleases", "doubleSettles", "doubleStarts", "drainFailClosed", "reservationsRejected")


def status(port):
    # Next bridge 的每个端点都要 Bearer token；token 从会话注册表读（见 tools/verified_workbench.py）
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
    from verified_workbench import auth_headers
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"http://127.0.0.1:{port}/status", headers=auth_headers(port))
    with opener.open(request, timeout=10) as response:
        return json.load(response)


def rss_kb(pid):
    """Resident memory of one process in KiB, or None when it cannot be read."""
    try:
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=20).stdout
            field = out.strip().split('","')[-1].strip('"')
            return int("".join(ch for ch in field if ch.isdigit()))
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=20).stdout
        return int(out.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def tree_bytes(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def snapshot(port, temp_dir):
    s = status(port)
    gate = (s.get("executionGate") or {}).get("counters") or {}
    pids = s.get("ownedBackendPids") or []
    return {"at": time.time(), "status": s.get("status"), "busy": s.get("busy"),
            "backendOwnerId": s.get("backendOwnerId"), "ownedBackendPids": pids,
            "resetGeneration": s.get("resetGeneration"),
            "recoveryRequired": (s.get("recovery") or {}).get("required"),
            "openHttpCount": (s.get("executionGate") or {}).get("openHttpCount"),
            "gate": {k: gate.get(k) for k in GATE_ZERO + ("reservations",)},
            "backendRssKb": {str(p): rss_kb(p) for p in pids},
            "tempBytes": tree_bytes(temp_dir) if temp_dir else None}


def dispatch(repo, env, cwd, receipt, max_wait, label):
    started = time.time()
    argv = [sys.executable, "-B", str(repo / "tools/shared_stata.py"), "--code", JOB, "--cwd", str(cwd),
            "--receipt-dir", str(receipt), "--busy-policy", "wait", "--max-wait", str(max_wait), "--label", label]
    proc = subprocess.run(argv, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    try:
        result = json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        result = {"verdict": "UNPARSED", "stdoutTail": proc.stdout[-400:], "stderrTail": proc.stderr[-400:]}
    window = {}
    try:
        full = json.loads((receipt / "result.json").read_text(encoding="utf-8"))
        window = {"executeStarted": full.get("startedAtEpoch"), "executeEnded": full.get("endedAtEpoch")}
    except (OSError, ValueError):
        pass
    return {"label": label, "exitCode": proc.returncode, "verdict": result.get("verdict"),
            "postCount": result.get("postCount"), "runId": result.get("runId"),
            "requestId": result.get("requestId"), "failedChecks": result.get("failedChecks"),
            "error": result.get("error"), "wallSeconds": round(time.time() - started, 3), **window}


def summarize(jobs, before, after, groups):
    """Correctness verdict from job receipts and two snapshots; pure function."""
    problems = []
    passed = [j for j in jobs if j["verdict"] == "PASS_VISIBLE_SHARED_RUN" and j["postCount"] == 1]
    if len(passed) != len(jobs):
        problems.append(f"{len(jobs) - len(passed)} job(s) did not pass with exactly one POST")
    for key in ("runId", "requestId"):
        ids = [j[key] for j in jobs if j.get(key)]
        if len(ids) != len(set(ids)) or len(ids) != len(jobs):
            problems.append(f"{key} values are missing or repeated")
    for key in ("backendOwnerId", "ownedBackendPids", "resetGeneration"):
        if before[key] != after[key]:
            problems.append(f"{key} changed: {before[key]!r} -> {after[key]!r}")
    if after["recoveryRequired"] is not False or after["busy"]:
        problems.append("instance is not idle and recovery-free after the run")
    if after["openHttpCount"] not in (0, None):
        problems.append(f"openHttpCount is {after['openHttpCount']}")
    for key in GATE_ZERO:
        if (after["gate"].get(key) or 0) != (before["gate"].get(key) or 0):
            problems.append(f"gate counter {key} moved")
    overlaps = 0
    for group in groups:
        spans = sorted((j["executeStarted"], j["executeEnded"]) for j in group
                       if j.get("executeStarted") is not None and j.get("executeEnded") is not None)
        if len(spans) != len(group):
            problems.append("a concurrent job has no execution window")
        overlaps += sum(1 for a, b in zip(spans, spans[1:]) if b[0] < a[1])
    if overlaps:
        problems.append(f"{overlaps} concurrent execution window(s) overlap")
    rss = {p: (before["backendRssKb"].get(p), after["backendRssKb"].get(p)) for p in after["backendRssKb"]}
    return {"verdict": "PASS" if not problems else "FAIL", "problems": problems, "jobs": len(jobs),
            "passed": len(passed), "overlappingConcurrentWindows": overlaps,
            "observed": {"backendRssKb": rss,
                         "tempBytes": [before["tempBytes"], after["tempBytes"]],
                         "reservations": [before["gate"].get("reservations"), after["gate"].get("reservations")],
                         "wallSeconds": [j["wallSeconds"] for j in jobs]}}


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, help="acceptance root written by acceptance.py prepare")
    p.add_argument("--repo", type=Path, help="source checkout to run (default: the root's recorded repo)")
    p.add_argument("--cwd", type=Path, help="working directory for jobs (default: the root's workspace)")
    p.add_argument("--sequential", type=int, default=20)
    p.add_argument("--concurrent", type=int, default=4, help="jobs per concurrent group")
    p.add_argument("--groups", type=int, default=3)
    p.add_argument("--out", type=Path, required=True, help="new directory for receipts and the summary")
    args = p.parse_args(argv)
    env = dict(os.environ)
    if args.root:
        state = json.loads((args.root / "acceptance.json").read_text(encoding="utf-8"))
        env.update(state["environment"])
        repo, cwd = args.repo or Path(state["repo"]), args.cwd or Path(state["work"])
    else:
        if not (args.repo and args.cwd):
            p.error("--repo and --cwd are required without --root")
        repo, cwd = args.repo, args.cwd
    port = int(env.get("STATA_WORKBENCH_PORT", "17601"))
    temp_dir = env.get("MCP_STATA_TEMP")
    args.out.mkdir(parents=True)  # refuses an existing directory; receipts are never reused
    log = (args.out / "jobs.jsonl").open("x", encoding="utf-8")
    before = snapshot(port, temp_dir)
    if before["busy"] or before["status"] != "idle" or before["recoveryRequired"] is not False:
        raise SystemExit("instance is not idle and recovery-free; nothing dispatched")
    jobs, groups, tag = [], [], uuid.uuid4().hex[:8]

    def record(job):
        jobs.append(job)
        log.write(json.dumps(job, ensure_ascii=False) + "\n")
        log.flush()

    for i in range(args.sequential):
        record(dispatch(repo, env, cwd, args.out / f"seq-{i:03d}", 60, f"stress {tag} seq {i}"))
    for g in range(args.groups):
        wait = 60 * args.concurrent
        with ThreadPoolExecutor(max_workers=args.concurrent) as pool:
            futures = [pool.submit(dispatch, repo, env, cwd, args.out / f"con-{g:02d}-{k:02d}", wait,
                                   f"stress {tag} group {g} job {k}") for k in range(args.concurrent)]
            group = [f.result() for f in futures]
        for job in group:
            record(job)
        groups.append(group)
    log.close()
    after = snapshot(port, temp_dir)
    summary = summarize(jobs, before, after, groups)
    summary.update(before=before, after=after, repo=str(repo), cwd=str(cwd), tag=tag)
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: summary[k] for k in ("verdict", "problems", "jobs", "passed", "overlappingConcurrentWindows")},
                     ensure_ascii=False))
    return 0 if summary["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
