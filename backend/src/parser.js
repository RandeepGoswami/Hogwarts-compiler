/**
 * Lumos — Phase 2: Syntax Analysis
 * -----------------------------------------------------------------
 * A recursive-descent parser with proper operator precedence and
 * panic-mode error recovery, so one missing semicolon doesn't hide
 * every other mistake in the file.
 *
 * Grammar (EBNF-ish):
 *   program    := (funcDecl | varDecl)*
 *   funcDecl   := type IDENT "(" params? ")" block
 *   varDecl    := "const"? type declarator ("," declarator)* ";"
 *   declarator := IDENT ("=" expr)?
 *   stmt       := varDecl | ifStmt | whileStmt | forStmt | returnStmt
 *               | breakStmt | continueStmt | printStmt | block | exprStmt
 *   expr       := assignment
 *   assignment := logicalOr (("="|"+="|"-="|"*="|"/="|"%=") assignment)?
 *   logicalOr  := logicalAnd ("||" logicalAnd)*
 *   logicalAnd := equality ("&&" equality)*
 *   equality   := relational (("=="|"!=") relational)*
 *   relational := additive (("<"|">"|"<="|">=") additive)*
 *   additive   := multiplicative (("+"|"-") multiplicative)*
 *   multiplicative := unary (("*"|"/"|"%") unary)*
 *   unary      := ("-"|"!"|"++"|"--") unary | postfix
 *   postfix    := primary ("(" args? ")" | "++" | "--")*
 *   primary    := NUMBER | STRING | CHAR | "true" | "false" | IDENT | "(" expr ")"
 */

const { tokenize } = require('./lexer');

const TYPES = new Set(['int', 'float', 'double', 'char', 'bool', 'string', 'void']);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

function parse(source) {
  const { tokens, diagnostics: lexDiagnostics } = tokenize(source);
  const diagnostics = [...lexDiagnostics];
  let pos = 0;

  const peek = (k = 0) => tokens[Math.min(pos + k, tokens.length - 1)];
  const at = () => peek(0);
  const atEnd = () => at().type === 'eof';

  function check(type, value) {
    const t = at();
    if (t.type !== type) return false;
    if (value !== undefined && t.value !== value) return false;
    return true;
  }
  function checkAny(type, values) {
    const t = at();
    return t.type === type && values.includes(t.value);
  }
  function next() { return tokens[pos++]; }

  function error(message, hint, token = at()) {
    // Don't stack up a dozen cascading errors from one bad line.
    const last = diagnostics[diagnostics.length - 1];
    if (last && last.line === token.line && last.phase === 'parser') return;
    diagnostics.push({
      phase: 'parser', severity: 'error',
      line: token.line, col: token.col,
      message, hint,
    });
  }

  function expect(type, value, message, hint) {
    if (check(type, value)) return next();
    error(message || `Expected "${value}" but found "${at().value}".`, hint);
    return null;
  }

  // Panic-mode recovery: skip to something that plausibly starts a new
  // statement so parsing can continue and report later errors too.
  function synchronize() {
    while (!atEnd()) {
      if (check('operator', ';')) { next(); return; }
      if (check('operator', '}')) return;
      const t = at();
      if (t.type === 'keyword' && (TYPES.has(t.value) || ['if', 'while', 'for', 'return', 'print', 'const', 'break', 'continue'].includes(t.value))) return;
      next();
    }
  }

  const isTypeToken = (t = at()) => t.type === 'keyword' && TYPES.has(t.value);

  // ------------------------------------------------------------------
  // Top level
  // ------------------------------------------------------------------
  function parseProgram() {
    const body = [];
    let guard = 0;
    while (!atEnd()) {
      if (guard++ > 20000) break;
      const before = pos;
      const decl = parseTopLevel();
      if (decl) body.push(decl);
      if (pos === before) next(); // never spin forever
    }
    return { kind: 'Program', body };
  }

  function parseTopLevel() {
    const startPos = pos;
    const isConst = check('keyword', 'const');
    if (isConst) next();

    if (!isTypeToken()) {
      error(
        `Unexpected "${at().value}" at the top level.`,
        'Top level may only contain variable declarations and function definitions.',
      );
      synchronize();
      return null;
    }

    const typeTok = next();
    const nameTok = expect('identifier', undefined, `Expected a name after type "${typeTok.value}".`, 'Declarations look like: int score = 10;');
    if (!nameTok) { synchronize(); return null; }

    // function?
    if (check('operator', '(')) {
      if (isConst) error('A function cannot be declared const here.', 'Remove the const before the return type.');
      return parseFunctionRest(typeTok, nameTok);
    }

    pos = startPos;
    return parseVarDecl();
  }

  function parseFunctionRest(typeTok, nameTok) {
    expect('operator', '(');
    const params = [];
    if (!check('operator', ')')) {
      do {
        if (!isTypeToken()) {
          error(`Expected a parameter type, found "${at().value}".`, 'Parameters look like: int a, string name');
          break;
        }
        const pType = next();
        const pName = expect('identifier', undefined, 'Expected a parameter name after its type.');
        if (!pName) break;
        params.push({ kind: 'Param', type: pType.value, name: pName.value, line: pType.line });
      } while (check('operator', ',') && next());
    }
    expect('operator', ')', 'Expected ")" to close the parameter list.');
    const body = parseBlock();
    return {
      kind: 'FunctionDecl',
      returnType: typeTok.value,
      name: nameTok.value,
      params,
      body,
      line: typeTok.line,
    };
  }

  function parseVarDecl() {
    const isConst = check('keyword', 'const');
    if (isConst) next();
    const typeTok = next(); // guaranteed type by caller
    if (typeTok.value === 'void') {
      error('Variables cannot have type void.', 'void is only valid as a function return type.', typeTok);
    }
    const declarators = [];
    do {
      const nameTok = expect('identifier', undefined, `Expected a variable name after "${typeTok.value}".`);
      if (!nameTok) break;
      let init = null;
      if (check('operator', '=')) {
        next();
        init = parseExpression();
      }
      declarators.push({
        kind: 'Declarator', name: nameTok.value, init,
        line: nameTok.line, col: nameTok.col,
      });
    } while (check('operator', ',') && next());

    if (!expect('operator', ';', `Missing ";" at the end of this declaration.`, 'Every declaration ends with a semicolon.')) {
      synchronize();
    }

    return {
      kind: 'VarDecl', type: typeTok.value, isConst, declarators, line: typeTok.line,
    };
  }

  // ------------------------------------------------------------------
  // Statements
  // ------------------------------------------------------------------
  function parseBlock() {
    const line = at().line;
    if (!expect('operator', '{', 'Expected "{" to open a block.')) {
      return { kind: 'Block', body: [], line };
    }
    const body = [];
    let guard = 0;
    while (!check('operator', '}') && !atEnd()) {
      if (guard++ > 20000) break;
      const before = pos;
      const stmt = parseStatement();
      if (stmt) body.push(stmt);
      if (pos === before) next();
    }
    expect('operator', '}', 'Expected "}" to close this block.', 'Check that every { has a matching }.');
    return { kind: 'Block', body, line };
  }

  function parseStatement() {
    const t = at();

    if (t.type === 'operator' && t.value === '{') return parseBlock();
    if (t.type === 'operator' && t.value === ';') { next(); return null; } // stray empty statement

    if (t.type === 'keyword') {
      if (t.value === 'const' || TYPES.has(t.value)) return parseVarDecl();
      if (t.value === 'if') return parseIf();
      if (t.value === 'while') return parseWhile();
      if (t.value === 'for') return parseFor();
      if (t.value === 'return') return parseReturn();
      if (t.value === 'print') return parsePrint();
      if (t.value === 'break' || t.value === 'continue') {
        next();
        expect('operator', ';', `Missing ";" after ${t.value}.`);
        return { kind: t.value === 'break' ? 'Break' : 'Continue', line: t.line };
      }
      if (t.value === 'else') {
        error('"else" without a matching "if".', 'Did you close the if-block too early?');
        next();
        return null;
      }
    }

    // expression statement
    const expr = parseExpression();
    if (!expect('operator', ';', 'Missing ";" at the end of this statement.')) synchronize();
    if (!expr) return null;
    return { kind: 'ExprStmt', expr, line: t.line };
  }

  function parseParenExpr() {
    expect('operator', '(', 'Expected "(" here.');
    const expr = parseExpression();
    expect('operator', ')', 'Expected ")" to close the condition.');
    return expr;
  }

  function parseIf() {
    const line = next().line; // 'if'
    const test = parseParenExpr();
    const consequent = parseStatement();
    let alternate = null;
    if (check('keyword', 'else')) {
      next();
      alternate = parseStatement();
    }
    return { kind: 'If', test, consequent, alternate, line };
  }

  function parseWhile() {
    const line = next().line;
    const test = parseParenExpr();
    const body = parseStatement();
    return { kind: 'While', test, body, line };
  }

  function parseFor() {
    const line = next().line;
    expect('operator', '(', 'Expected "(" after for.');
    let init = null;
    if (check('operator', ';')) next();
    else if (isTypeToken() || check('keyword', 'const')) init = parseVarDecl();
    else {
      const e = parseExpression();
      expect('operator', ';', 'Expected ";" after the for-initializer.');
      init = e ? { kind: 'ExprStmt', expr: e, line } : null;
    }

    let test = null;
    if (!check('operator', ';')) test = parseExpression();
    expect('operator', ';', 'Expected ";" after the for-condition.');

    let update = null;
    if (!check('operator', ')')) update = parseExpression();
    expect('operator', ')', 'Expected ")" to close the for-header.');

    const body = parseStatement();
    return { kind: 'For', init, test, update, body, line };
  }

  function parseReturn() {
    const line = next().line;
    let argument = null;
    if (!check('operator', ';')) argument = parseExpression();
    if (!expect('operator', ';', 'Missing ";" after return.')) synchronize();
    return { kind: 'Return', argument, line };
  }

  function parsePrint() {
    const line = next().line;
    expect('operator', '(', 'print takes its argument in parentheses: print(x);');
    const args = [];
    if (!check('operator', ')')) {
      do { args.push(parseExpression()); } while (check('operator', ',') && next());
    }
    expect('operator', ')', 'Expected ")" to close print(...).');
    if (!expect('operator', ';', 'Missing ";" after print(...).')) synchronize();
    return { kind: 'Print', args: args.filter(Boolean), line };
  }

  // ------------------------------------------------------------------
  // Expressions (precedence climbing)
  // ------------------------------------------------------------------
  function parseExpression() { return parseAssignment(); }

  function parseAssignment() {
    const left = parseLogicalOr();
    if (left && at().type === 'operator' && ASSIGN_OPS.has(at().value)) {
      const opTok = next();
      const right = parseAssignment();
      if (left.kind !== 'Identifier') {
        error('The left side of an assignment must be a variable.', 'You can only assign into a named variable.', opTok);
      }
      return { kind: 'Assign', op: opTok.value, target: left, value: right, line: opTok.line };
    }
    return left;
  }

  function binaryLevel(nextFn, ops) {
    return function parseLevel() {
      let left = nextFn();
      while (left && at().type === 'operator' && ops.includes(at().value)) {
        const opTok = next();
        const right = nextFn();
        left = { kind: 'Binary', op: opTok.value, left, right, line: opTok.line, col: opTok.col };
      }
      return left;
    };
  }

  const parseMultiplicative = binaryLevel(() => parseUnary(), ['*', '/', '%']);
  const parseAdditive = binaryLevel(parseMultiplicative, ['+', '-']);
  const parseRelational = binaryLevel(parseAdditive, ['<', '>', '<=', '>=']);
  const parseEquality = binaryLevel(parseRelational, ['==', '!=']);
  const parseLogicalAnd = binaryLevel(parseEquality, ['&&']);
  const parseLogicalOr = binaryLevel(parseLogicalAnd, ['||']);

  function parseUnary() {
    if (at().type === 'operator' && ['-', '!', '+', '++', '--'].includes(at().value)) {
      const opTok = next();
      const operand = parseUnary();
      if (opTok.value === '++' || opTok.value === '--') {
        return { kind: 'Update', op: opTok.value, prefix: true, target: operand, line: opTok.line };
      }
      if (opTok.value === '+') return operand;
      return { kind: 'Unary', op: opTok.value, operand, line: opTok.line, col: opTok.col };
    }
    return parsePostfix();
  }

  function parsePostfix() {
    let expr = parsePrimary();
    for (;;) {
      if (check('operator', '(') && expr && expr.kind === 'Identifier') {
        next();
        const args = [];
        if (!check('operator', ')')) {
          do { args.push(parseExpression()); } while (check('operator', ',') && next());
        }
        expect('operator', ')', 'Expected ")" to close the argument list.');
        expr = { kind: 'Call', callee: expr.name, args: args.filter(Boolean), line: expr.line, col: expr.col };
        continue;
      }
      if (checkAny('operator', ['++', '--'])) {
        const opTok = next();
        expr = { kind: 'Update', op: opTok.value, prefix: false, target: expr, line: opTok.line };
        continue;
      }
      break;
    }
    return expr;
  }

  function parsePrimary() {
    const t = at();

    if (t.type === 'number') {
      next();
      return {
        kind: 'Literal',
        literalType: t.literalType,
        value: t.literalType === 'int' ? parseInt(t.value, 10) : parseFloat(t.value),
        raw: t.value, line: t.line, col: t.col,
      };
    }
    if (t.type === 'string') {
      next();
      return { kind: 'Literal', literalType: 'string', value: t.value, raw: `"${t.value}"`, line: t.line, col: t.col };
    }
    if (t.type === 'char') {
      next();
      return { kind: 'Literal', literalType: 'char', value: t.value, raw: `'${t.value}'`, line: t.line, col: t.col };
    }
    if (t.type === 'keyword' && (t.value === 'true' || t.value === 'false')) {
      next();
      return { kind: 'Literal', literalType: 'bool', value: t.value === 'true', raw: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'identifier') {
      next();
      return { kind: 'Identifier', name: t.value, line: t.line, col: t.col };
    }
    if (check('operator', '(')) {
      next();
      const e = parseExpression();
      expect('operator', ')', 'Expected ")" to close this expression.');
      return e;
    }

    error(
      `Expected a value here, but found "${t.value}".`,
      'An expression needs a literal, a variable, or a parenthesised sub-expression.',
    );
    if (!atEnd() && !check('operator', ';') && !check('operator', '}')) next();
    return null;
  }

  const ast = parseProgram();
  return { ast, tokens, diagnostics };
}

module.exports = { parse, TYPES };
