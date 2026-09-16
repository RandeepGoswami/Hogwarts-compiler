/**
 * Lumos — Phase 1: Lexical Analysis
 * -----------------------------------------------------------------
 * Hand-written scanner. Turns raw source text into a flat token
 * stream with line/column info, so every later phase can point at a
 * precise place in the user's code.
 */

const KEYWORDS = new Set([
  'int', 'float', 'double', 'char', 'bool', 'string', 'void',
  'const', 'if', 'else', 'while', 'for', 'return', 'break', 'continue',
  'true', 'false', 'print',
]);

const TYPE_KEYWORDS = new Set(['int', 'float', 'double', 'char', 'bool', 'string', 'void']);

// Longest first — the scanner tries these in order.
const OPERATORS = [
  '<<', '>>',
  '&&', '||',
  '==', '!=', '<=', '>=',
  '+=', '-=', '*=', '/=', '%=',
  '++', '--',
  '+', '-', '*', '/', '%',
  '<', '>', '=', '!',
  '(', ')', '{', '}', '[', ']',
  ';', ',',
];

class LexError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'LexError';
    this.line = line;
    this.col = col;
  }
}

function isDigit(c) { return c >= '0' && c <= '9'; }
function isIdentStart(c) { return /[A-Za-z_]/.test(c); }
function isIdentPart(c) { return /[A-Za-z0-9_]/.test(c); }

function tokenize(source) {
  const tokens = [];
  const diagnostics = [];
  let i = 0;
  let line = 1;
  let col = 1;

  const peek = (k = 0) => source[i + k];

  function advance(n = 1) {
    for (let k = 0; k < n; k++) {
      if (source[i] === '\n') { line++; col = 1; } else { col++; }
      i++;
    }
  }

  function push(type, value, startLine, startCol) {
    tokens.push({ type, value, line: startLine, col: startCol });
  }

  while (i < source.length) {
    const c = source[i];

    // --- whitespace -------------------------------------------------
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { advance(); continue; }

    // --- preprocessor lines (#include ...) are skipped wholesale -----
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    // --- comments ---------------------------------------------------
    if (c === '/' && peek(1) === '/') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (c === '/' && peek(1) === '*') {
      const sl = line, sc = col;
      advance(2);
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && peek(1) === '/') { advance(2); closed = true; break; }
        advance();
      }
      if (!closed) {
        diagnostics.push({
          phase: 'lexer', severity: 'error', line: sl, col: sc,
          message: 'Unterminated block comment — this /* never finds its */.',
          hint: 'Close the comment with */ before the end of the file.',
        });
      }
      continue;
    }

    const startLine = line, startCol = col;

    // --- numbers ----------------------------------------------------
    if (isDigit(c) || (c === '.' && isDigit(peek(1)))) {
      let text = '';
      let isFloat = false;
      while (i < source.length && isDigit(source[i])) { text += source[i]; advance(); }
      if (source[i] === '.' && isDigit(peek(1))) {
        isFloat = true;
        text += '.'; advance();
        while (i < source.length && isDigit(source[i])) { text += source[i]; advance(); }
      }
      if (source[i] === 'f' || source[i] === 'F') { isFloat = true; advance(); }
      if (i < source.length && isIdentStart(source[i])) {
        diagnostics.push({
          phase: 'lexer', severity: 'error', line: startLine, col: startCol,
          message: `Malformed number literal near "${text}${source[i]}".`,
          hint: 'A number cannot be immediately followed by a letter.',
        });
        while (i < source.length && isIdentPart(source[i])) advance();
        continue;
      }
      push('number', text, startLine, startCol);
      tokens[tokens.length - 1].literalType = isFloat ? 'float' : 'int';
      continue;
    }

    // --- identifiers & keywords -------------------------------------
    if (isIdentStart(c)) {
      let text = '';
      while (i < source.length && isIdentPart(source[i])) { text += source[i]; advance(); }
      if (text === 'using' ) {
        // `using namespace std;` — tolerated and skipped, it's C++ noise.
        while (i < source.length && source[i] !== ';') advance();
        if (source[i] === ';') advance();
        continue;
      }
      push(KEYWORDS.has(text) ? 'keyword' : 'identifier', text, startLine, startCol);
      continue;
    }

    // --- strings ----------------------------------------------------
    if (c === '"') {
      advance();
      let text = '';
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) { text += source[i] + source[i + 1]; advance(2); continue; }
        if (source[i] === '"') { advance(); closed = true; break; }
        if (source[i] === '\n') break;
        text += source[i]; advance();
      }
      if (!closed) {
        diagnostics.push({
          phase: 'lexer', severity: 'error', line: startLine, col: startCol,
          message: 'Unterminated string literal.',
          hint: 'Every opening " needs a matching closing " on the same line.',
        });
        continue;
      }
      push('string', text, startLine, startCol);
      continue;
    }

    // --- chars ------------------------------------------------------
    if (c === "'") {
      advance();
      let text = '';
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\' && i + 1 < source.length) { text += source[i] + source[i + 1]; advance(2); continue; }
        if (source[i] === "'") { advance(); closed = true; break; }
        if (source[i] === '\n') break;
        text += source[i]; advance();
      }
      if (!closed) {
        diagnostics.push({
          phase: 'lexer', severity: 'error', line: startLine, col: startCol,
          message: 'Unterminated character literal.',
          hint: "Character literals look like 'a' — one character between single quotes.",
        });
        continue;
      }
      if (text.length === 0 || (text.length > 1 && text[0] !== '\\')) {
        diagnostics.push({
          phase: 'lexer', severity: 'error', line: startLine, col: startCol,
          message: `Character literal '${text}' must hold exactly one character.`,
          hint: 'Use double quotes for text longer than one character.',
        });
      }
      push('char', text, startLine, startCol);
      continue;
    }

    // --- operators & punctuation ------------------------------------
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      advance(op.length);
      push('operator', op, startLine, startCol);
      continue;
    }

    diagnostics.push({
      phase: 'lexer', severity: 'error', line: startLine, col: startCol,
      message: `Unexpected character "${c}" in source.`,
      hint: 'Remove it, or check for a typo in the surrounding expression.',
    });
    advance();
  }

  tokens.push({ type: 'eof', value: '<eof>', line, col });
  return { tokens, diagnostics };
}

module.exports = { tokenize, KEYWORDS, TYPE_KEYWORDS, LexError };
