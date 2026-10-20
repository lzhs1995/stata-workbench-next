"use strict";

// A deliberately small scanner, not a Stata interpreter. Keep offsets stable so
// only literal DO path tokens change; comments and displayed text remain intact.
function statements(source) {
  // Use UTF-16 offsets, matching String.slice and RegExp.index (including emoji).
  const mask = source.split("");
  let block = 0, compound = 0, quoted = false, lineStart = true;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], n = source[i + 1];
    if (block) {
      if (c === "/" && n === "*") { block++; mask[i] = mask[++i] = " "; }
      else if (c === "*" && n === "/") { block--; mask[i] = mask[++i] = " "; }
      else mask[i] = " ";
      continue;
    }
    if (compound) {
      // A newline inside a string is not a new command. Keep the same offsets
      // but join the masked statement so displayed DO text cannot be executed.
      if (c === "\n" || c === "\r") mask[i] = " ";
      if (c === "`" && n === '"') { compound++; i++; }
      else if (c === '"' && n === "'") { compound--; i++; }
      continue;
    }
    if (quoted) {
      if (c === "\n" || c === "\r") mask[i] = " ";
      if (c === '"') quoted = false;
      continue;
    }
    if (c === "`" && n === '"') { compound = 1; lineStart = false; i++; continue; }
    if (c === '"') { quoted = true; lineStart = false; continue; }
    if (c === "/" && n === "*") { block = 1; mask[i] = mask[++i] = " "; continue; }
    if ((c === "/" && n === "/") || (lineStart && c === "*")) {
      const continuation = source.slice(i, i + 3) === "///";
      while (i < source.length && source[i] !== "\n") mask[i++] = " ";
      if (continuation && i < source.length) { mask[i] = " "; lineStart = false; }
      else lineStart = true;
      continue;
    }
    if (c === "\n") lineStart = true;
    else if (!/\s/.test(c)) lineStart = false;
  }
  const clean = mask.join("");
  const out = [];
  const re = /[^\n]*(?:\n|$)/g;
  let match;
  while ((match = re.exec(clean)) && match[0]) out.push({ text: match[0], offset: match.index });
  return out;
}

function scanDoReferences(source) {
  const refs = [], unsupported = [];
  let changesCwd = false;
  const lines = statements(source);
  const semicolon = lines.some(({ text }) => /^\s*#delimit\s*;/i.test(text));
  for (const { text, offset } of lines) {
    const head = text.match(/^\s*(?:(?:cap(?:ture)?|qui(?:etly)?|noi(?:sily)?)\s+)*(do|run|include|cd|chdir)\s+/i);
    if (!head) continue;
    const command = head[1].toLowerCase();
    if (command === "cd" || command === "chdir") { changesCwd = true; continue; }
    const token = text.slice(head[0].length).match(/^"([^"\r\n]+\.do)"(?=\s|$)/i);
    if (semicolon || command !== "do" || !token || /[$`]/.test(token[1])) {
      unsupported.push({ command, offset, reason: semicolon ? "semicolon-delimiter" : "nonliteral-or-unsupported-command" });
      continue;
    }
    const start = offset + head[0].length + 1;
    refs.push({ start, end: start + token[1].length, filePath: token[1] });
  }
  return { refs, unsupported, changesCwd };
}

module.exports = { scanDoReferences };
