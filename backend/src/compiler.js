/**
 * Lumos — pipeline orchestrator
 * -----------------------------------------------------------------
 * Runs every phase and returns a single structured payload, so the
 * UI can show the source transforming stage by stage: tokens → AST →
 * symbols → IR → optimized IR → assembly.
 *
 * The pipeline never throws on bad user input; it collects
 * diagnostics and stops at the first phase that cannot continue.
 */

const { tokenize } = require('./lexer');
const { parse } = require('./parser');
const { analyze } = require('./semantic');
const { buildIR, formatQuad } = require('./ir');
const { optimize } = require('./optimizer');
const { generate } = require('./codegen');

const PHASES = [
  { id: 'lexer', title: 'Lexical Analysis', blurb: 'Source text becomes a token stream' },
  { id: 'parser', title: 'Syntax Analysis', blurb: 'Tokens become an abstract syntax tree' },
  { id: 'semantic', title: 'Semantic Analysis', blurb: 'Scopes, types and symbol resolution' },
  { id: 'ir', title: 'IR Generation', blurb: 'Three-address code with explicit control flow' },
  { id: 'optimizer', title: 'Optimization', blurb: 'Nine passes run to a fixed point' },
  { id: 'codegen', title: 'Code Generation', blurb: 'x86-64 with linear-scan register allocation' },
];

function summarizeAst(node) {
  if (!node || typeof node !== 'object') return node;
  switch (node.kind) {
    case 'Program':
      return { label: 'Program', kind: 'Program', children: node.body.map(summarizeAst) };
    case 'FunctionDecl':
      return {
        label: `${node.returnType} ${node.name}(${node.params.map((p) => `${p.type} ${p.name}`).join(', ')})`,
        kind: 'Function',
        children: node.body ? node.body.body.map(summarizeAst) : [],
      };
    case 'VarDecl':
      return {
        label: `${node.isConst ? 'const ' : ''}${node.type}`,
        kind: 'Declaration',
        children: node.declarators.map((d) => ({
          label: d.name, kind: 'Declarator',
          children: d.init ? [summarizeAst(d.init)] : [],
        })),
      };
    case 'Block':
      return { label: 'Block', kind: 'Block', children: node.body.map(summarizeAst) };
    case 'If':
      return {
        label: 'If', kind: 'Control',
        children: [
          { label: 'condition', kind: 'Slot', children: [summarizeAst(node.test)] },
          { label: 'then', kind: 'Slot', children: [summarizeAst(node.consequent)] },
          ...(node.alternate ? [{ label: 'else', kind: 'Slot', children: [summarizeAst(node.alternate)] }] : []),
        ],
      };
    case 'While':
      return {
        label: 'While', kind: 'Control',
        children: [
          { label: 'condition', kind: 'Slot', children: [summarizeAst(node.test)] },
          { label: 'body', kind: 'Slot', children: [summarizeAst(node.body)] },
        ],
      };
    case 'For':
      return {
        label: 'For', kind: 'Control',
        children: [
          node.init && { label: 'init', kind: 'Slot', children: [summarizeAst(node.init)] },
          node.test && { label: 'condition', kind: 'Slot', children: [summarizeAst(node.test)] },
          node.update && { label: 'update', kind: 'Slot', children: [summarizeAst(node.update)] },
          { label: 'body', kind: 'Slot', children: [summarizeAst(node.body)] },
        ].filter(Boolean),
      };
    case 'Return':
      return { label: 'Return', kind: 'Control', children: node.argument ? [summarizeAst(node.argument)] : [] };
    case 'Print':
      return { label: 'Print', kind: 'Call', children: node.args.map(summarizeAst) };
    case 'ExprStmt':
      return summarizeAst(node.expr);
    case 'Binary':
      return { label: node.op, kind: 'Operator', type: node.type, children: [summarizeAst(node.left), summarizeAst(node.right)] };
    case 'Unary':
      return { label: `unary ${node.op}`, kind: 'Operator', type: node.type, children: [summarizeAst(node.operand)] };
    case 'Update':
      return { label: `${node.prefix ? 'pre' : 'post'} ${node.op}`, kind: 'Operator', type: node.type, children: [summarizeAst(node.target)] };
    case 'Assign':
      return { label: node.op, kind: 'Assign', type: node.type, children: [summarizeAst(node.target), summarizeAst(node.value)] };
    case 'Call':
      return { label: `${node.callee}()`, kind: 'Call', type: node.type, children: node.args.map(summarizeAst) };
    case 'Identifier':
      return { label: node.name, kind: 'Identifier', type: node.type };
    case 'Literal':
      return { label: node.raw, kind: 'Literal', type: node.type || node.literalType };
    case 'Break':
    case 'Continue':
      return { label: node.kind, kind: 'Control' };
    default:
      return { label: node.kind || '?', kind: 'Node' };
  }
}

function compile(source) {
  const result = {
    phases: PHASES.map((p) => ({ ...p, status: 'pending', detail: '' })),
    diagnostics: [],
    tokens: [],
    ast: null,
    symbols: [],
    functions: [],
    typeCheck: null,
    ir: [],
    optimizedIr: [],
    optimizationLog: [],
    optimizationStats: null,
    asm: { naive: [], optimized: [], metrics: null, allocations: [] },
    ok: false,
  };

  const setPhase = (id, status, detail) => {
    const p = result.phases.find((x) => x.id === id);
    if (p) { p.status = status; p.detail = detail; }
  };

  if (typeof source !== 'string' || !source.trim()) {
    result.diagnostics.push({
      phase: 'lexer', severity: 'error', line: 1,
      message: 'There is nothing to compile.',
      hint: 'Write some code in the editor first.',
    });
    setPhase('lexer', 'error', 'empty source');
    ['parser', 'semantic', 'ir', 'optimizer', 'codegen']
      .forEach((id) => setPhase(id, 'skipped', 'nothing to do'));
    return result;
  }

  // --- Phase 1: lexing -----------------------------------------------
  const lex = tokenize(source);
  result.tokens = lex.tokens.slice(0, 600).map((t) => ({
    type: t.type, value: t.value, line: t.line, col: t.col,
  }));
  result.diagnostics.push(...lex.diagnostics);
  const lexErrors = lex.diagnostics.filter((d) => d.severity === 'error').length;
  setPhase('lexer', lexErrors ? 'error' : 'ok', `${lex.tokens.length - 1} tokens`);

  // --- Phase 2: parsing ----------------------------------------------
  const parsed = parse(source);
  const parseErrors = parsed.diagnostics.filter((d) => d.severity === 'error' && d.phase === 'parser');
  result.diagnostics.push(...parsed.diagnostics.filter((d) => d.phase === 'parser'));
  result.ast = summarizeAst(parsed.ast);
  setPhase('parser', parseErrors.length ? 'error' : 'ok',
    parseErrors.length ? `${parseErrors.length} syntax error(s)` : `${parsed.ast.body.length} top-level declaration(s)`);

  if (lexErrors || parseErrors.length) {
    ['semantic', 'ir', 'optimizer', 'codegen'].forEach((id) => setPhase(id, 'skipped', 'blocked by earlier errors'));
    result.diagnostics.sort((a, b) => a.line - b.line);
    return result;
  }

  // --- Phase 3: semantics ---------------------------------------------
  const sema = analyze(parsed.ast);
  result.diagnostics.push(...sema.diagnostics);
  result.symbols = sema.symbolTable;
  result.functions = sema.functions;

  const byRule = {};
  (sema.judgements || []).forEach((j) => { byRule[j.rule] = (byRule[j.rule] || 0) + 1; });
  result.typeCheck = {
    judgements: sema.judgements || [],
    byRule,
    checks: (sema.judgements || []).length,
    conversions: (sema.judgements || []).filter((j) => /widening|narrowing|conversions/.test(j.rule)).length,
    errors: sema.diagnostics.filter((d) => d.severity === 'error').length,
    warnings: sema.diagnostics.filter((d) => d.severity === 'warning').length,
  };
  const semaErrors = sema.diagnostics.filter((d) => d.severity === 'error');
  const semaWarnings = sema.diagnostics.filter((d) => d.severity === 'warning');
  setPhase('semantic', semaErrors.length ? 'error' : (semaWarnings.length ? 'warn' : 'ok'),
    semaErrors.length
      ? `${semaErrors.length} type error(s)`
      : `${sema.symbolTable.length} symbol(s), ${semaWarnings.length} warning(s)`);

  if (semaErrors.length) {
    ['ir', 'optimizer', 'codegen'].forEach((id) => setPhase(id, 'skipped', 'blocked by type errors'));
    result.diagnostics.sort((a, b) => (a.line - b.line) || (a.severity === 'error' ? -1 : 1));
    return result;
  }

  // --- Phase 4: IR ----------------------------------------------------
  const ir = buildIR(parsed.ast);
  result.ir = ir.functions.map((f) => ({
    name: f.name,
    lines: f.code.map(formatQuad),
  }));
  const irCount = ir.functions.reduce((n, f) => n + f.code.length, 0);
  setPhase('ir', 'ok', `${irCount} three-address instruction(s)`);

  // --- Phase 5: optimization -------------------------------------------
  const opt = optimize(ir);
  result.optimizedIr = opt.functions.map((f) => ({ name: f.name, lines: f.code.map(formatQuad) }));
  result.optimizationLog = opt.functions.flatMap((f) => f.log.map((l) => ({ ...l, fn: f.name })));
  const totals = opt.functions.reduce((acc, f) => {
    Object.entries(f.stats).forEach(([k, v]) => { acc[k] = (acc[k] || 0) + v; });
    return acc;
  }, {});
  const optCount = opt.functions.reduce((n, f) => n + f.code.length, 0);
  result.optimizationStats = {
    ...totals,
    irBefore: irCount,
    irAfter: optCount,
    irReduction: irCount ? Math.round(((irCount - optCount) / irCount) * 100) : 0,
    rewrites: result.optimizationLog.length,
  };
  setPhase('optimizer', 'ok',
    `${result.optimizationLog.length} rewrite(s), IR ${irCount} → ${optCount}`);

  // --- Phase 6: codegen -------------------------------------------------
  const code = generate(ir.functions, opt.functions);
  result.asm = code;
  setPhase('codegen', 'ok',
    `${code.metrics.naiveInstructions} → ${code.metrics.optimizedInstructions} instructions`);

  result.ok = true;
  result.diagnostics.sort((a, b) => a.line - b.line);
  return result;
}

module.exports = { compile, PHASES };
