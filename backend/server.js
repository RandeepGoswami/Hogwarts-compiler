/**
 * Department of Magical Syntax — AI Agent Backend
 * ---------------------------------------------------------
 * Deterministic lexing/parsing/type-checking happens here in real code
 * (that's how a real compiler pipeline works — you don't want an LLM
 * guessing whether "9.5" is a float). The AI AGENT is used for the two
 * jobs that genuinely benefit from a language model:
 *   1. Explaining a type error like a Hogwarts professor ("Sorting Hat")
 *   2. Suggesting an optimization pass over the generated code
 *
 * The agent is powered directly by the OpenAI API
 * (https://platform.openai.com/docs/api-reference/chat), authenticated
 * with your own OPENAI_API_KEY.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

const PORT = process.env.PORT || 4000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// ---------------------------------------------------------------------
// AI agent call helper
// ---------------------------------------------------------------------
async function callAgent(messages, { temperature = 0.7, max_tokens = 400 } = {}) {
  if (!OPENAI_API_KEY) {
    return { ok: false, reason: 'no_token' };
  }

  try {
    const resp = await fetch(OPENAI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages,
        temperature,
        max_tokens,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('OpenAI API error', resp.status, errText);
      return { ok: false, reason: 'api_error', status: resp.status, detail: errText };
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) return { ok: false, reason: 'empty_response' };
    return { ok: true, content };
  } catch (err) {
    console.error('OpenAI API request failed', err);
    return { ok: false, reason: 'network_error', detail: String(err) };
  }
}

// ---------------------------------------------------------------------
// Deterministic type checker (Phases 1 & 2 — real, no AI)
// ---------------------------------------------------------------------
function typeCheck(code) {
  const lines = code.split('\n');
  let hasError = false;
  let errorContext = null;
  const validDeclarations = [];
  const declRegex = /^\s*(int|float|double|string|char|bool)\s+([a-zA-Z_]\w*)\s*=\s*(.+);/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      !line ||
      line.startsWith('//') ||
      line.startsWith('#') ||
      line.includes('main') ||
      line.includes('return') ||
      line === '{' ||
      line === '}'
    ) {
      continue;
    }

    const match = line.match(declRegex);
    if (!match) continue;

    const expectedType = match[1];
    const varName = match[2];
    const rawValue = match[3].trim();
    let inferredType = 'unknown';

    if (/^"[^"]*"$/.test(rawValue)) inferredType = 'string';
    else if (/^'[^']'$/.test(rawValue)) inferredType = 'char';
    else if (/^-?\d+\.\d+f?$/.test(rawValue)) inferredType = 'float';
    else if (/^-?\d+$/.test(rawValue)) inferredType = 'int';
    else if (rawValue === 'true' || rawValue === 'false') inferredType = 'bool';

    let isValid = expectedType === inferredType;
    if ((expectedType === 'float' || expectedType === 'double') && inferredType === 'int') {
      isValid = true;
    }

    if (isValid) {
      validDeclarations.push({ type: expectedType, name: varName, val: rawValue });
    } else {
      hasError = true;
      errorContext = {
        line: i + 1,
        varName,
        expected: expectedType,
        actual: inferredType,
        value: rawValue,
      };
      break;
    }
  }

  return { hasError, errorContext, validDeclarations };
}

// ---------------------------------------------------------------------
// Deterministic unoptimized codegen (Phase 3 — real, no AI)
// ---------------------------------------------------------------------
function generateCode(declarations) {
  const asm = [];
  asm.push('; --- MAGICAL ASSEMBLY (x86-64 STACK ALLOCATION) ---');
  asm.push('section .data');
  declarations.forEach((d) => {
    if (d.type === 'string') asm.push(`  ${d.name}_str: .string ${d.val}`);
  });
  asm.push('section .text');
  asm.push('  push rbp');
  asm.push('  mov rbp, rsp');

  let stackOffset = 4;
  declarations.forEach((d) => {
    if (['int', 'float', 'char', 'bool'].includes(d.type)) {
      asm.push(`  ; store ${d.name} on stack`);
      asm.push(`  mov DWORD PTR [rbp-${stackOffset}], ${d.val}`);
      stackOffset += 4;
    } else if (d.type === 'string') {
      asm.push(`  ; store ${d.name} string pointer`);
      asm.push(`  mov QWORD PTR [rbp-${stackOffset}], OFFSET FLAT:${d.name}_str`);
      stackOffset += 8;
    }
  });

  asm.push('  pop rbp');
  asm.push('  ret');
  return asm;
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(OPENAI_API_KEY), model: OPENAI_MODEL });
});

/**
 * Runs the full deterministic pipeline (type check + codegen).
 * Returns structured results; the frontend decides which AI endpoint
 * to call next (explain-error or optimize).
 */
app.post('/api/pipeline/run', (req, res) => {
  const { code } = req.body || {};
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code (string) is required' });
  }

  const { hasError, errorContext, validDeclarations } = typeCheck(code);

  if (hasError) {
    return res.json({ hasError: true, errorContext });
  }

  const asm = generateCode(validDeclarations);
  return res.json({ hasError: false, declarations: validDeclarations, asm });
});

/**
 * AI AGENT — Type-checking assistant.
 * Takes the deterministic error context and asks the model to explain
 * it in-theme and suggest a fix.
 */
app.post('/api/ai/explain-error', async (req, res) => {
  const { line, varName, expected, actual, value } = req.body || {};
  if (!varName || !expected || !actual) {
    return res.status(400).json({ error: 'line, varName, expected, actual, value are required' });
  }

  const messages = [
    {
      role: 'system',
      content:
        "You are the Sorting Hat acting as a magical compiler's type-checking assistant, " +
        'in the Department of Magical Syntax at Hogwarts. You explain C++-style type errors ' +
        'in 2-3 sentences, in a warm, witty, Harry-Potter-flavored voice, using light wizarding ' +
        'metaphors (splinching, spells, wands, houses) without overdoing it. Always end with a ' +
        'concrete, correct fix the student can apply. Keep it under 80 words. No markdown.',
    },
    {
      role: 'user',
      content:
        `Line ${line}: variable "${varName}" was declared as type "${expected}" ` +
        `but assigned a value ("${value}") that is actually type "${actual}". ` +
        'Explain the mismatch and how to fix it.',
    },
  ];

  const result = await callAgent(messages, { temperature: 0.8, max_tokens: 200 });

  if (result.ok) {
    return res.json({ source: 'ai', explanation: result.content });
  }

  // Graceful fallback so the app still works without a configured token.
  const fallback =
    expected === 'int' && actual === 'string'
      ? `You are trying to stuff a text string into an integer vessel! Change the type of ${varName} to string, or remove the quotes for a numerical value.`
      : expected === 'string' && actual === 'int'
      ? `Numbers cannot be treated as text! Wrap your value in double quotes (like "${value}") to turn it into a valid string.`
      : `You declared ${expected} but gave it a ${actual}. Adjust your data type to match your value.`;

  return res.json({ source: 'fallback', reason: result.reason, explanation: fallback });
});

/**
 * AI AGENT — Code optimizer.
 * Takes the valid declarations + unoptimized assembly and asks the
 * model to propose a register-allocation-style optimization pass.
 */
app.post('/api/ai/optimize', async (req, res) => {
  const { declarations, asm } = req.body || {};
  if (!Array.isArray(declarations) || declarations.length === 0) {
    return res.status(400).json({ error: 'declarations (non-empty array) is required' });
  }

  const declSummary = declarations.map((d) => `${d.type} ${d.name} = ${d.val}`).join('; ');

  const messages = [
    {
      role: 'system',
      content:
        'You are an AI compiler-optimization agent for a teaching tool. Given a list of ' +
        'variable declarations and their unoptimized stack-based x86-64 assembly, propose a ' +
        'register-allocation optimization: which variables move into which registers, and why ' +
        "it's faster (fewer memory accesses, better pipelining). Respond as two parts separated " +
        'by "---": first a short (max 60 words) explanation in a whimsical Hogwarts-professor ' +
        'voice, then the optimized assembly-style pseudocode (one instruction per line, using ' +
        'mov/lea into registers like eax/ebx/ecx/edx/rax/rbx/rcx/rdx). No markdown fences.',
    },
    {
      role: 'user',
      content: `Declarations: ${declSummary}\n\nUnoptimized assembly:\n${(asm || []).join('\n')}`,
    },
  ];

  const result = await callAgent(messages, { temperature: 0.7, max_tokens: 400 });

  if (result.ok) {
    const [explanation, ...rest] = result.content.split('---');
    return res.json({
      source: 'ai',
      explanation: explanation.trim(),
      optimizedAsm: rest.join('---').trim(),
    });
  }

  // Graceful fallback so the app still works without a configured token.
  const registers32 = ['eax', 'ebx', 'ecx', 'edx'];
  const registers64 = ['rax', 'rbx', 'rcx', 'rdx'];
  let regIndex = 0;
  const optLines = [];
  declarations.forEach((d) => {
    if (['int', 'float', 'char', 'bool'].includes(d.type)) {
      const reg = registers32[regIndex % registers32.length];
      optLines.push(`mov ${reg}, ${d.val}  ; bound ${d.name} directly to register`);
      regIndex++;
    } else if (d.type === 'string') {
      const reg = registers64[regIndex % registers64.length];
      optLines.push(`lea ${reg}, [rel ${d.name}_str]  ; optimized string pointer reference`);
      regIndex++;
    }
  });

  return res.json({
    source: 'fallback',
    reason: result.reason,
    explanation:
      'Placing every variable on the stack is safe, but we can do better — binding hot variables directly to CPU registers keeps the instruction pipeline full.',
    optimizedAsm: optLines.join('\n'),
  });
});

app.listen(PORT, () => {
  console.log(`Department of Magical Syntax backend listening on port ${PORT}`);
  console.log(`AI agent configured: ${Boolean(OPENAI_API_KEY)} (model: ${OPENAI_MODEL})`);
});
