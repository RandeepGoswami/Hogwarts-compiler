# Lumos — the Department of Magical Syntax

A compiler built around two phases: a **static type checker** that refuses to
guess, and a **code optimizer** that shows every rewrite it makes. Write a small
C-like program, press Compile, and the UI walks you through it — the judgement
trace and symbol table the checker produced, then the pass log and before/after
intermediate code the optimizer produced. Scanning, parsing and code generation
are there too, but they're supporting acts.

The UI is themed as a wizarding-school lab: the type checker is the Sorting Hat
(it gives every value its proper type), the optimizer is the Room of Requirement
(it keeps only the instructions the program actually needs), the target code is
the Pensieve, and the AI reviewer is the oracle. Four house palettes — Gryffindor,
Slytherin, Ravenclaw, Hufflepuff — swap the accent colour and persist between
visits. The theming stops at the chrome: diagnostics, judgements and pass notes
stay literal, because a compiler message that is being cute is a compiler message
you cannot act on.

```
lumos/
├── backend/
│   ├── src/
│   │   ├── lexer.js       Phase 1 — scanner with line/column tracking
│   │   ├── parser.js      Phase 2 — recursive descent + error recovery
│   │   ├── semantic.js    Phase 3 — scoped symbol table + type checking
│   │   ├── ir.js          Phase 4 — three-address code generation
│   │   ├── optimizer.js   Phase 5 — ten passes to a fixed point
│   │   ├── codegen.js     Phase 6 — x86-64 + linear-scan allocation
│   │   └── compiler.js    pipeline orchestration
│   ├── test/compiler.test.js
│   └── server.js          Express API + Gemini calls
├── frontend/index.html    single-file UI, no build step
├── render.yaml            backend blueprint for Render
└── vercel.json            static frontend config for Vercel
```

## The language

Lumos compiles a C-flavoured teaching language:

- types `int`, `float`, `double`, `char`, `bool`, `string`, `void`, plus `const`
- functions with parameters, calls, and recursion
- `if` / `else`, `while`, `for`, `break`, `continue`, `return`, blocks and scopes
- full expression precedence, unary `-` and `!`, `++` / `--` (prefix and postfix),
  compound assignment (`+=`, `-=`, `*=`, `/=`, `%=`), short-circuit `&&` and `||`
- multi-declarator lines (`int a = 1, b = 2;`), string and char literals, `print(...)`

## What each phase does

**1. Scan.** Characters become tokens with positions. Comments (`//`, `/* */`)
and preprocessor lines are stripped; unterminated strings, bad numbers and stray
characters are reported rather than silently dropped.

**2. Parse.** Recursive descent with precedence climbing builds an AST. On a
syntax error the parser panics to the next statement boundary and keeps going,
so one missing semicolon doesn't hide every other mistake in the file.

**3. Type check (primary).** A scope chain resolves every name and annotates every expression
with a type. This phase reports undeclared identifiers, redeclarations, shadowing,
`const` violations, narrowing conversions, non-boolean conditions, bad operand
types, wrong argument counts and types, missing returns, `break` outside a loop,
unreachable code, unused variables, reads before assignment, and division by a
constant zero. Every judgement it makes — declaration types, implicit widening,
narrowing, arithmetic promotion, comparison results, argument binding, return
types — is recorded in order and surfaced as a readable trace, so you can see
*why* a program was accepted, not just that it was.

**4. Lower.** The AST becomes three-address code. Control flow turns into labels
and conditional jumps; `&&` and `||` lower to real short-circuit branches;
expressions become chains of temporaries.

**5. Optimize (primary).** Ten passes run repeatedly until the IR stops changing, because
each one exposes work for the others:

| Pass | Example |
|---|---|
| Constant folding | `2 + 3 * 4` → `14` |
| Constant propagation | `x = 5; y = x + 1` → `y = 6` |
| Algebraic simplification | `x * 1`, `x + 0`, `x - x` |
| Strength reduction | `x * 8` → `x << 3` |
| Common subexpression elimination | reuse an identical earlier result |
| Copy propagation | `t1 = x; y = t1` → `y = x` |
| Dead code elimination | drop values nothing reads |
| Branch simplification | `ifFalse false goto L` → unconditional |
| Unreachable code removal | delete instructions no path reaches |
| Label cleanup | drop labels nothing jumps to |

Every rewrite is logged with its before, its after, and why it's valid — that
log is what the UI and the AI reviewer both read.

**6. Emit.** Two builds are generated. The naive one gives every value a stack
slot; the optimized one computes live ranges, runs linear-scan allocation over
the callee-saved registers, spills the longest-lived value when it runs out, and
reports the instruction-count delta between the two.

## Reparo — automatic error fixing

Section II has a "Cast Reparo" button (named for the actual Harry Potter
mending charm) that rewrites the source to resolve type errors on its own,
with one hard rule: **nothing is ever reported as fixed without a clean
recompile behind it.** The endpoint (`POST /api/ai/autofix`) never trusts its
own output — it always recompiles the result before responding.

Two passes run in order:

1. **Deterministic pattern fixes** — no AI, no network call. Handles the
   error shapes that have one obviously-correct rewrite: unquoting a numeric
   string literal, retyping a declaration when the string is genuinely text,
   quoting a bare value assigned to a `string`, removing `const` so a later
   reassignment is legal, declaring a stub for an undeclared name, rewriting
   an untestable string condition (`if (name)` → `if (name != "")`), and
   changing a constant-zero divisor. Multiple independent fixes can stack on
   the same physical line.
2. **A Gemini pass on whatever's left**, if a key is configured. The model is
   told to change as little as possible and output nothing but corrected
   source. Its output is recompiled immediately; if the error count didn't
   go down, the rewrite is discarded and never shown as a success.

The response always reports `originalErrorCount`, the list of `fixes`
applied (each tied to a line, in plain language), whether it's `fullyFixed`,
and any `remainingErrors` — so a partial fix is shown honestly as partial,
never dressed up as complete. The frontend applies accepted fixes to the
editor and offers an "Undo Reparo" button to restore the pre-fix source.

## The AI layer

The compiler is deterministic. The model is only asked to do the two things a
language model is genuinely better at:

- `POST /api/ai/explain` — takes a diagnostic the compiler already produced and
  explains it in plain language, naming the underlying concept and the exact fix.
- `POST /api/ai/review` — reads the pass log, the register allocation and the
  measured instruction counts, then explains what the optimizer managed, what it
  was blocked from doing, and how to write this program so it compiles better.

Without a `GEMINI_API_KEY` both endpoints fall back to deterministic answers
built from the compiler's own output, so nothing in the UI breaks.

## API

| Route | Purpose |
|---|---|
| `GET /api/health` | backend status, whether the AI key is configured |
| `POST /api/compile` | `{ code }` → phases, diagnostics, tokens, AST, symbols, type-check trace, IR, optimized IR, pass log, assembly, metrics |
| `POST /api/pipeline/run` | alias of `/api/compile` for the previous API shape |
| `POST /api/ai/explain` | `{ diagnostic, snippet }` → explanation |
| `POST /api/ai/review` | build artifacts → three-part review |
| `POST /api/ai/autofix` | `{ code }` → deterministic + AI-assisted error fixes, verified by recompiling |

## Run it locally

```bash
cd backend
npm install
cp .env.example .env        # optional: paste a Gemini key
npm start                   # http://localhost:4000
npm test                    # 22 compiler tests, no dependencies needed
```

Then open `frontend/index.html` in a browser, or serve the folder with any
static server. It talks to `http://localhost:4000` by default.

## Deploy

**Backend on Render.** Push to GitHub, then New → Blueprint and point it at the
repo. `render.yaml` creates the `lumos-backend` service with root directory
`backend`. Set `GEMINI_API_KEY` in the dashboard (it's marked `sync: false`, so
Render prompts for it and you never commit a key).

**Frontend on Vercel.** Add New → Project against the same repo; `vercel.json`
serves `frontend/` as static output with no build step. Point it at your backend
by adding one line above the main script in `index.html`:

```html
<script>window.LUMOS_API_BASE = 'https://lumos-backend.onrender.com';</script>
```

CORS is open on the backend. To lock it down for submission:

```js
app.use(cors({ origin: 'https://your-frontend.vercel.app' }));
```

## Extending it

- Arrays and pointers: the parser already has postfix hooks for `[` and `]`.
- Loop-invariant code motion and induction-variable strength reduction — the IR
  has the labels and jumps you'd need to identify loop bodies.
- A real control-flow graph would let the optimizer keep facts across joins
  instead of forgetting everything at each label.
- Interprocedural constant propagation, so calls to pure functions with literal
  arguments fold like any other constant.
