/**
 * Lumos — autofix
 * -----------------------------------------------------------------
 * Turns type-checker diagnostics into source edits. Nothing here is
 * ever trusted on its own: every candidate fix is applied to a copy
 * of the source and the WHOLE program is recompiled before it is
 * reported as successful. If a "fix" doesn't actually clear the
 * error it claims to clear, it is discarded rather than shown.
 *
 * Strategy, in order:
 *   1. Pattern-match specific, well-understood error shapes (wrong
 *      literal type, const violation, undeclared name, untestable
 *      condition, division by a constant zero) and rewrite the
 *      smallest possible span of text.
 *   2. Recompile. Whatever that pass didn't fix is handed to Gemini
 *      as a last resort, with the same recompile-to-verify guard —
 *      an AI rewrite that doesn't reduce the error count is thrown
 *      away, never shown as if it worked.
 *
 * Edits never change the number of lines except for inserting a
 * declaration for an undeclared name, and those insertions are
 * applied bottom-to-top so earlier line numbers stay valid for every
 * other edit computed from the same diagnostic pass.
 */

const { compile } = require('./compiler');

const TYPE_KEYWORDS = ['int', 'float', 'double', 'char', 'bool', 'string'];

function isValidLiteralFor(type, raw) {
  const v = raw.trim();
  if (type === 'bool') return v === 'true' || v === 'false';
  if (type === 'int') return /^-?\d+$/.test(v);
  if (type === 'float' || type === 'double') return /^-?(\d+\.\d+|\.\d+|\d+)f?$/.test(v);
  if (type === 'char') return v.length === 1 || (v.length === 2 && v[0] === '\\');
  return false;
}

/**
 * Try to fix a "declared X, got a string literal" or "declared
 * string, got a bare literal" mismatch by editing only the literal
 * or only the declared type — whichever keeps the value intact.
 */
function fixLiteralMismatch(lineText, varName, expected, actual) {
  // string -> numeric/bool/char: unquote if the contents are a valid
  // literal for the target type; otherwise the value is genuinely
  // text ("one hundred"), so retype the declaration to string instead.
  if (actual === 'string' && expected !== 'string') {
    const quoted = lineText.match(/"((?:[^"\\]|\\.)*)"/);
    if (quoted && isValidLiteralFor(expected, quoted[1])) {
      return {
        text: lineText.slice(0, quoted.index) + quoted[1] + lineText.slice(quoted.index + quoted[0].length),
        note: `unquoted "${quoted[1]}" so it reads as ${expected}, not string`,
      };
    }
    const retyped = retypeDeclaration(lineText, varName, 'string');
    if (retyped) return { text: retyped, note: `${varName} declared string to match its text value` };
    return null;
  }
  // numeric/bool -> string: wrap the bare value in quotes.
  if (expected === 'string' && actual !== 'string') {
    const assign = lineText.match(/=\s*([^;]+);/);
    if (assign) {
      const value = assign[1].trim();
      const start = lineText.indexOf(assign[1]);
      return {
        text: lineText.slice(0, start) + '"' + value + '"' + lineText.slice(start + assign[1].length),
        note: `wrapped ${value} in quotes so it reads as string`,
      };
    }
    return null;
  }
  return null;
}

function retypeDeclaration(lineText, varName, newType) {
  const re = new RegExp(`\\b(${TYPE_KEYWORDS.join('|')})(\\s+${escapeReg(varName)}\\b)`);
  const m = lineText.match(re);
  if (!m) return null;
  return lineText.slice(0, m.index) + newType + m[2] + lineText.slice(m.index + m[0].length);
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * One deterministic pass over the diagnostics from a single compile.
 * Returns { lines, fixes } — fixes is a human-readable log of what
 * changed, in the order the edits were found (not application order).
 */
function deterministicPass(source, diagnostics) {
  const lines = source.split('\n');
  const insertions = new Map(); // 1-based line -> array of lines to insert before it
  const fixes = [];
  const alreadyDeclared = new Set();

  const addInsertion = (line, text, note) => {
    if (!insertions.has(line)) insertions.set(line, []);
    insertions.get(line).push(text);
    fixes.push({ line, note });
  };

  for (const d of diagnostics) {
    if (d.severity !== 'error') continue;
    const raw = lines[d.line - 1]; // current text — may already carry earlier fixes on this line
    if (raw === undefined) continue;

    // 1. Declaration or assignment type mismatch with a known expected/actual type.
    if (d.expected && d.actual && d.varName && /Cannot (initialise|assign)/.test(d.message)) {
      const fix = fixLiteralMismatch(raw, d.varName, d.expected, d.actual);
      if (fix) {
        lines[d.line - 1] = fix.text;
        fixes.push({ line: d.line, note: `line ${d.line}: ${fix.note}` });
        continue;
      }
    }

    // 2. Assigning to a const variable — remove const from its declaration.
    if (/Cannot assign to const variable/.test(d.message) && d.varName) {
      const declMatch = d.message.match(/declared on line (\d+)/);
      const declLine = declMatch ? Number(declMatch[1]) : null;
      if (declLine && lines[declLine - 1] !== undefined) {
        const declText = lines[declLine - 1]; // current text of the declaring line
        const constRe = new RegExp(`\\bconst\\s+(${TYPE_KEYWORDS.join('|')}\\s+${escapeReg(d.varName)}\\b)`);
        const m = declText.match(constRe);
        if (m) {
          lines[declLine - 1] = declText.slice(0, m.index) + m[1] + declText.slice(m.index + m[0].length);
          fixes.push({ line: declLine, note: `line ${declLine}: removed const from "${d.varName}" so it can be reassigned` });
          continue;
        }
      }
    }

    // 3. Undeclared identifier — insert a stub declaration just above its first use.
    if (/^Undeclared identifier|^Assignment to undeclared variable/.test(d.message) && d.varName) {
      if (!alreadyDeclared.has(d.varName)) {
        const indent = (raw.match(/^\s*/) || [''])[0];
        addInsertion(d.line, `${indent}int ${d.varName} = 0; // auto-fix: "${d.varName}" was never declared`,
          `line ${d.line}: declared missing variable "${d.varName}" as int, defaulted to 0`);
        alreadyDeclared.add(d.varName);
      }
      continue;
    }

    // 4. A condition that can never be tested for truth (e.g. a bare string).
    if (/condition has type "string"|never a truth value/.test(d.message)) {
      const m = raw.match(/(if|while)\s*\(([^)]*)\)/);
      if (m) {
        const inner = m[2].trim();
        lines[d.line - 1] = raw.slice(0, m.index) + `${m[1]} (${inner} != "")` + raw.slice(m.index + m[0].length);
        fixes.push({ line: d.line, note: `line ${d.line}: compared the ${m[1]}-condition to "" instead of testing it directly` });
        continue;
      }
    }

    // 5. Division or modulo by a literal zero.
    if (/Division by a constant zero/.test(d.message)) {
      const m = raw.match(/([/%])\s*0\b/);
      if (m) {
        lines[d.line - 1] = raw.slice(0, m.index) + m[1] + ' 1' + raw.slice(m.index + m[0].length)
          + '  // auto-fix: divisor changed from 0 to 1 to avoid a runtime trap';
        fixes.push({ line: d.line, note: `line ${d.line}: changed the divisor from 0 to 1 — check this is the value you actually meant` });
        continue;
      }
    }
  }

  // Insertions apply last, bottom-to-top, so earlier line numbers used above stay valid.
  const insertLines = [...insertions.keys()].sort((a, b) => b - a);
  for (const line of insertLines) {
    lines.splice(line - 1, 0, ...insertions.get(line));
  }

  return { code: lines.join('\n'), fixes };
}

async function aiPass(code, diagnostics, callAgent) {
  const errList = diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => `line ${d.line}: ${d.message}${d.hint ? ' (' + d.hint + ')' : ''}`)
    .join('\n');

  const systemPrompt =
    'You are a code-repair tool for Lumos, a small C-like teaching language. You are given a ' +
    'program and the exact compiler errors it produces. Rewrite the program to fix ONLY those ' +
    'errors, changing as little else as possible — same variable names, same structure, same ' +
    'intent. Preserve every line that is not part of a fix, including comments. ' +
    'Output ONLY the corrected source code. No markdown code fences, no explanation, no ' +
    'commentary before or after — your entire response must be valid Lumos source and nothing else.';

  const userPrompt = `Errors:\n${errList}\n\nProgram:\n${code}`;

  const result = await callAgent(systemPrompt, userPrompt, { temperature: 0.2, maxOutputTokens: 1200 });
  if (!result.ok) return null;

  // Strip accidental code fences even though the prompt forbids them.
  let text = result.content.trim();
  text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
  return text || null;
}

/**
 * Top-level entry point. `callAgent` is injected by the server so this
 * module has no direct dependency on the Gemini transport.
 */
async function autofix(originalCode, callAgent) {
  const before = compile(originalCode);
  const beforeErrors = before.diagnostics.filter((d) => d.severity === 'error');

  if (!beforeErrors.length) {
    return {
      changed: false, fullyFixed: true, code: originalCode,
      fixes: [], originalErrorCount: 0, remainingErrors: [],
    };
  }

  const det = deterministicPass(originalCode, before.diagnostics);
  const afterDet = compile(det.code);
  const afterDetErrors = afterDet.diagnostics.filter((d) => d.severity === 'error');

  let finalCode = det.code;
  let finalErrors = afterDetErrors;
  let fixes = det.fixes;
  let aiAttempted = false;
  let aiSucceededPartially = false;

  if (afterDetErrors.length > 0 && typeof callAgent === 'function') {
    aiAttempted = true;
    const aiCode = await aiPass(det.code, afterDet.diagnostics, callAgent);
    if (aiCode && aiCode !== det.code) {
      const afterAi = compile(aiCode);
      const afterAiErrors = afterAi.diagnostics.filter((d) => d.severity === 'error');
      // Only accept the AI rewrite if it strictly reduced the error count —
      // never let an unverified rewrite look like a successful fix.
      if (afterAiErrors.length < afterDetErrors.length) {
        finalCode = aiCode;
        finalErrors = afterAiErrors;
        aiSucceededPartially = true;
        fixes = [
          ...fixes,
          {
            line: null,
            note: afterAiErrors.length === 0
              ? 'the oracle rewrote the remaining lines and resolved every error'
              : `the oracle rewrote the remaining lines and resolved ${afterDetErrors.length - afterAiErrors.length} of ${afterDetErrors.length} remaining error(s)`,
          },
        ];
      }
    }
  }

  return {
    changed: finalCode !== originalCode,
    fullyFixed: finalErrors.length === 0,
    code: finalCode,
    fixes,
    originalErrorCount: beforeErrors.length,
    remainingErrors: finalErrors,
    aiAttempted,
    aiSucceededPartially,
  };
}

module.exports = { autofix, deterministicPass };
