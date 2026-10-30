"""The stress verdict is computed from receipts and snapshots only; no Stata."""
import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "examples/platform-acceptance/stress.py"
spec = importlib.util.spec_from_file_location("stress_kit", SCRIPT)
stress = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stress)


def snap(**changes):
    base = {"status": "idle", "busy": False, "backendOwnerId": "b-1", "ownedBackendPids": [11],
            "resetGeneration": 0, "recoveryRequired": False, "openHttpCount": 0,
            "gate": {k: 0 for k in stress.GATE_ZERO + ("reservations",)},
            "backendRssKb": {"11": 1000}, "tempBytes": 10}
    base.update(changes)
    return base


def job(i, start=None, end=None, **changes):
    base = {"label": str(i), "verdict": "PASS_VISIBLE_SHARED_RUN", "postCount": 1,
            "runId": f"run-{i}", "requestId": f"req-{i}", "wallSeconds": 1.0,
            "executeStarted": start if start is not None else 10.0 * i,
            "executeEnded": end if end is not None else 10.0 * i + 5}
    base.update(changes)
    return base


class StressVerdictTests(unittest.TestCase):
    def test_serialized_jobs_pass(self):
        jobs = [job(i) for i in range(4)]
        result = stress.summarize(jobs, snap(), snap(), [jobs[1:]])
        self.assertEqual(result["verdict"], "PASS", result["problems"])
        self.assertEqual(result["overlappingConcurrentWindows"], 0)

    def test_overlapping_concurrent_windows_fail(self):
        group = [job(1, 0, 6), job(2, 5, 9)]
        result = stress.summarize(group, snap(), snap(), [group])
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["overlappingConcurrentWindows"], 1)

    def test_failed_or_retried_job_fails(self):
        for bad in (job(1, verdict="EXECUTION_UNCONFIRMED_NO_RETRY"), job(1, postCount=2)):
            result = stress.summarize([job(0), bad], snap(), snap(), [])
            self.assertEqual(result["verdict"], "FAIL")

    def test_repeated_or_missing_ids_fail(self):
        for bad in (job(1, runId="run-0"), job(1, requestId=None)):
            result = stress.summarize([job(0), bad], snap(), snap(), [])
            self.assertTrue(any("values are missing or repeated" in p for p in result["problems"]))

    def test_backend_reset_or_gate_movement_fails(self):
        gate = {k: 0 for k in stress.GATE_ZERO + ("reservations",)}
        for after in (snap(backendOwnerId="b-2"), snap(ownedBackendPids=[12]), snap(resetGeneration=1),
                      snap(recoveryRequired=True), snap(openHttpCount=1),
                      snap(gate={**gate, "doubleReleases": 1})):
            self.assertEqual(stress.summarize([job(0)], snap(), after, [])["verdict"], "FAIL")

    def test_resource_growth_is_observed_not_judged(self):
        result = stress.summarize([job(0)], snap(), snap(backendRssKb={"11": 9000}, tempBytes=999), [])
        self.assertEqual(result["verdict"], "PASS")
        self.assertEqual(result["observed"]["backendRssKb"], {"11": (1000, 9000)})

    def test_missing_execution_window_in_group_fails(self):
        group = [job(1), job(2, executeStarted=None)]
        group[1]["executeStarted"] = None
        self.assertEqual(stress.summarize(group, snap(), snap(), [group])["verdict"], "FAIL")


if __name__ == "__main__":
    unittest.main()
