/**
 * Lumos — backend
 * -----------------------------------------------------------------
 * A real six-phase compiler (lexer → parser → semantic analysis → IR
 * → optimizer → x86-64 codegen) plus an AI layer that does the two
 * jobs a language model is actually good at:
 *
 *   1. Explaining a diagnostic in plain language, with a fix.
 *   2. Reviewing the whole program and the optimizer's own decisions.
 *
 * The compiler itself is deterministic. You never want an LLM
 * guessing whether "9.5" is a float.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { compile } = require('./src/compiler');

const app = express();
app.use(cors());
app.use(express.json({ limit: '400kb' }));

const PORT = process.env.PORT || 4000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const MAX_SOURCE_BYTES = 40000;

// ---------------------------------------------------------------------
// AI helper
// ---------------------------------------------------------------------
async function callAgent(systemPrompt, userPrompt, { temperature = 0.6, maxOutputTokens = 500 } = {}) {
  if (!GEMINI_API_KEY) return { ok: false, reason: 'no_token' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: { temperature, maxOutputTokens },
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('Gemini API error', resp.status, detail);
      return { ok: false, reason: 'api_error', status: resp.status, detail };
    }

    const data = await resp.json();
    const candidate = data && data.candidates && data.candidates[0];
    const content = candidate && candidate.content && candidate.content.parts
      ? candidate.content.parts.map((p) => p.text || '').join('').trim()
      : '';
    if (!content) {
      return { ok: false, reason: 'empty_response', detail: (candidate && candidate.finishReason) || 'unknown' };
    }
    return { ok: true, content };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    console.error('Gemini request failed', err);
    return { ok: false, reason: aborted ? 'timeout' : 'network_error', detail: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    provider: 'gemini',
    phases: 6,
    version: '3.0.0',
  });
});

/** Full pipeline. Deterministic, no AI, no network. */
function runCompile(req, res) {
  const { code } = req.body || {};
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code (string) is required' });
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_SOURCE_BYTES) {
    return res.status(413).json({ error: `Source is too large (limit ${MAX_SOURCE_BYTES} bytes).` });
  }

  const started = Date.now();
  try {
    const result = compile(code);
    result.timings = { totalMs: Date.now() - started };
    return res.json(result);
  } catch (err) {
    console.error('Compiler crashed', err);
    return res.status(500).json({
      error: 'The compiler hit an internal error.',
      detail: String(err && err.message ? err.message : err),
    });
  }
}

app.post('/api/compile', runCompile);
// Backwards-compatible alias for the previous API shape.
app.post('/api/pipeline/run', runCompile);

/**
 * AI — explain a diagnostic.
 * The compiler has already decided what is wrong; the model only has
 * to make it make sense.
 */
app.post('/api/ai/explain', async (req, res) => {
  const { diagnostic, snippet } = req.body || {};
  if (!diagnostic || !diagnostic.message) {
    return res.status(400).json({ error: 'diagnostic is required' });
  }

  const systemPrompt =
    'You are a compiler teaching assistant inside Lumos, a small educational compiler. ' +
    'A deterministic compiler phase has already produced a diagnostic — you do not second-guess it. ' +
    'Explain, in 2-4 plain sentences, what the compiler saw, why that rule exists, and the exact ' +
    'edit that fixes it. Be concrete and friendly, never condescending. Name the underlying ' +
    'compiler concept (type coercion, scope, liveness, const-correctness, and so on) so the ' +
    'reader learns something. No markdown, no headings, under 90 words.';

  const userPrompt = [
    `Phase: ${diagnostic.phase}`,
    `Severity: ${diagnostic.severity}`,
    `Line ${diagnostic.line}: ${diagnostic.message}`,
    diagnostic.hint ? `Compiler hint: ${diagnostic.hint}` : '',
    snippet ? `Offending line:\n${snippet}` : '',
  ].filter(Boolean).join('\n');

  const result = await callAgent(systemPrompt, userPrompt, { temperature: 0.55, maxOutputTokens: 260 });

  if (result.ok) return res.json({ source: 'ai', explanation: result.content });

  return res.json({
    source: 'fallback',
    reason: result.reason,
    explanation: [
      diagnostic.message,
      diagnostic.hint || '',
      `(${diagnostic.phase} phase, line ${diagnostic.line}.)`,
    ].filter(Boolean).join(' '),
  });
});

/**
 * AI — review the compiled program and the optimizer's own work.
 * This runs after a successful build, so the model comments on real
 * measured numbers rather than inventing them.
 */
app.post('/api/ai/review', async (req, res) => {
  const { code, optimizationLog, optimizationStats, metrics, allocations, warnings } = req.body || {};
  if (typeof code !== 'string') {
    return res.status(400).json({ error: 'code (string) is required' });
  }

  const passes = (optimizationLog || []).slice(0, 25)
    .map((l) => `${l.pass}: ${l.before}  =>  ${l.after}`).join('\n');
  const regs = (allocations || [])
    .map((a) => {
      const pairs = (a.allocation || []).map((x) => `${x.name}->${x.reg}`).join(', ') || 'none';
      const spill = a.spilled && a.spilled.length ? ` | spilled: ${a.spilled.join(', ')}` : '';
      return `${a.fn}: ${pairs}${spill}`;
    })
    .join('\n');

  const systemPrompt =
    'You are the optimization reviewer for Lumos, an educational compiler. You are given a source ' +
    'program, the exact rewrites its optimizer performed, the register allocation it chose, and ' +
    'measured instruction counts. Write a short review in three sections separated by lines ' +
    'containing only "---":\n' +
    'WHAT THE OPTIMIZER DID — 2-3 sentences citing the specific passes that fired and what they bought.\n' +
    'WHAT IT COULD NOT DO — 1-2 sentences on an optimization that was blocked, and why (unknown ' +
    'runtime values, function calls, aliasing, loop-carried dependencies).\n' +
    'HOW TO WRITE FASTER CODE HERE — 2-3 concrete suggestions about THIS program.\n' +
    'Never invent numbers you were not given. Plain prose, no markdown, under 180 words total.';

  const userPrompt = [
    `Source:\n${code.slice(0, 4000)}`,
    optimizationStats ? `\nOptimizer stats: ${JSON.stringify(optimizationStats)}` : '',
    metrics ? `\nInstruction counts: naive ${metrics.naiveInstructions}, optimized ${metrics.optimizedInstructions} (${metrics.reduction}% fewer)` : '',
    passes ? `\nRewrites performed:\n${passes}` : '\nRewrites performed: none',
    regs ? `\nRegister allocation:\n${regs}` : '',
    (warnings && warnings.length) ? `\nCompiler warnings:\n${warnings.join('\n')}` : '',
  ].join('\n');

  const result = await callAgent(systemPrompt, userPrompt, { temperature: 0.65, maxOutputTokens: 600 });

  if (result.ok) {
    const parts = result.content.split(/\n?-{3,}\n?/);
    return res.json({
      source: 'ai',
      sections: {
        did: clean(parts[0]),
        blocked: clean(parts[1]),
        advice: clean(parts[2]),
      },
    });
  }

  return res.json({
    source: 'fallback',
    reason: result.reason,
    sections: fallbackReview(optimizationStats, metrics),
  });
});

function clean(text) {
  if (!text) return '';
  return text
    .replace(/^\s*(WHAT THE OPTIMIZER DID|WHAT IT COULD NOT DO|HOW TO WRITE FASTER CODE HERE)\s*[—:-]*\s*/i, '')
    .trim();
}

function fallbackReview(stats, metrics) {
  const s = stats || {};
  const fired = Object.entries({
    'constant folding': s.folded,
    'constant propagation': s.propagated,
    'algebraic simplification': s.simplified,
    'strength reduction': s.strength,
    'common subexpression elimination': s.cse,
    'copy propagation': s.copies,
    'dead code elimination': s.dead,
    'branch simplification': s.branches,
    'unreachable code removal': s.unreachable,
  }).filter(([, n]) => n > 0).map(([name, n]) => `${name} (${n}x)`);

  return {
    did: fired.length
      ? `The optimizer applied ${fired.join(', ')}, taking the IR from ${s.irBefore} to ${s.irAfter} instructions${metrics ? ` and the emitted assembly from ${metrics.naiveInstructions} to ${metrics.optimizedInstructions}` : ''}.`
      : 'No rewrites fired — every value in this program depends on something the compiler cannot know until runtime.',
    blocked:
      'Anything downstream of a function call or a loop-carried variable stays put: there is no interprocedural analysis here, so the optimizer must assume a call can change any value it did not prove local.',
    advice:
      'Hoist loop-invariant expressions out of the loop yourself, prefer const for values that never change so they fold away, and keep live ranges short — a variable used across a call has to survive in a callee-saved register or on the stack.',
  };
}

app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}` }));

app.listen(PORT, () => {
  console.log(`Lumos backend listening on port ${PORT}`);
  console.log(`AI reviewer: ${GEMINI_API_KEY ? `gemini / ${GEMINI_MODEL}` : 'disabled (no GEMINI_API_KEY) — deterministic fallbacks active'}`);
});
