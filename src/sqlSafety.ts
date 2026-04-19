type TokenType =
  | "identifier"
  | "number"
  | "string"
  | "boolean"
  | "null"
  | "operator"
  | "punct"
  | "eof";

interface Token {
  type: TokenType;
  value: string;
}

function escapeSqlLiteral(value: any) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function tokenizeFilter(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  const push = (type: TokenType, value: string) => {
    tokens.push({ type, value });
  };

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const twoChar = source.slice(index, index + 2);
    if (["&&", "||", "==", "!=", ">=", "<=", "!~"].includes(twoChar)) {
      push("operator", twoChar);
      index += 2;
      continue;
    }

    if (["=", ">", "<", "!", "~"].includes(char)) {
      push("operator", char);
      index += 1;
      continue;
    }

    if (["(", ")", "[", "]", ","].includes(char)) {
      push("punct", char);
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      let value = "";
      while (index < source.length) {
        const current = source[index];
        if (current === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      push("string", value);
      continue;
    }

    if (/[-\d]/.test(char)) {
      const match = source.slice(index).match(/^-?\d+(?:\.\d+)?/);
      if (match) {
        push("number", match[0]);
        index += match[0].length;
        continue;
      }
    }

    const match = source.slice(index).match(/^[A-Za-z_@][A-Za-z0-9_@.:-]*/);
    if (match) {
      const value = match[0];
      const lowered = value.toLowerCase();
      if (["and", "or", "not", "in"].includes(lowered)) {
        push("operator", lowered);
      } else if (lowered === "true" || lowered === "false") {
        push("boolean", lowered);
      } else if (lowered === "null") {
        push("null", lowered);
      } else {
        push("identifier", value);
      }
      index += value.length;
      continue;
    }

    throw new Error(
      `Unexpected token near: ${source.slice(index, index + 12)}`,
    );
  }

  tokens.push({ type: "eof", value: "" });
  return tokens;
}

class FilterParser {
  private index = 0;
  private tokens: Token[];
  private allowedColumns: Map<string, string>;

  constructor(
    private source: string,
    allowedColumns: Iterable<string>,
  ) {
    this.tokens = tokenizeFilter(source);
    this.allowedColumns = new Map(
      Array.from(allowedColumns, (name) => [name.toLowerCase(), name]),
    );
  }

  parse() {
    const value = this.parseOr();
    this.expect("eof");
    return value;
  }

  private peek(offset = 0) {
    return (
      this.tokens[this.index + offset] || this.tokens[this.tokens.length - 1]
    );
  }

  private consume() {
    return this.tokens[this.index++] || this.tokens[this.tokens.length - 1];
  }

  private matchOperator(...values: string[]) {
    const token = this.peek();
    if (token.type === "operator" && values.includes(token.value)) {
      this.consume();
      return true;
    }
    return false;
  }

  private matchPunct(...values: string[]) {
    const token = this.peek();
    if (token.type === "punct" && values.includes(token.value)) {
      this.consume();
      return true;
    }
    return false;
  }

  private expect(type: TokenType, values?: string[]) {
    const token = this.consume();
    if (token.type !== type) {
      throw new Error(`Expected ${type} but found ${token.type}`);
    }
    if (values && !values.includes(token.value)) {
      throw new Error(
        `Expected one of ${values.join(", ")} but found ${token.value}`,
      );
    }
    return token;
  }

  private parseOr(): string {
    let left = this.parseAnd();
    while (this.matchOperator("||") || this.matchOperator("or")) {
      const right = this.parseAnd();
      left = `(${left} OR ${right})`;
    }
    return left;
  }

  private parseAnd(): string {
    let left = this.parseUnary();
    while (this.matchOperator("&&") || this.matchOperator("and")) {
      const right = this.parseUnary();
      left = `(${left} AND ${right})`;
    }
    return left;
  }

  private parseUnary(): string {
    if (this.matchOperator("!") || this.matchOperator("not")) {
      return `(NOT ${this.parseUnary()})`;
    }
    return this.parseComparison();
  }

  private parseComparison(): string {
    const left = this.parsePrimary();
    const token = this.peek();
    if (token.type !== "operator") {
      return left;
    }

    const op = token.value;
    if (
      !["=", "==", "!=", ">", ">=", "<", "<=", "~", "!~", "in"].includes(op)
    ) {
      return left;
    }

    this.consume();
    const right = this.parsePrimary();

    if (op === "in" && !right.startsWith("(")) {
      throw new Error("IN requires a list on the right-hand side.");
    }

    switch (op) {
      case "=":
      case "==":
        return `(${left} = ${right})`;
      case "!=":
        return `(${left} <> ${right})`;
      case ">":
        return `(${left} > ${right})`;
      case ">=":
        return `(${left} >= ${right})`;
      case "<":
        return `(${left} < ${right})`;
      case "<=":
        return `(${left} <= ${right})`;
      case "~":
        return `(CAST(${left} AS text) ILIKE '%' || CAST(${right} AS text) || '%')`;
      case "!~":
        return `(CAST(${left} AS text) NOT ILIKE '%' || CAST(${right} AS text) || '%')`;
      case "in":
        return `(${left} IN ${right})`;
      default:
        return left;
    }
  }

  private parsePrimary(): string {
    const token = this.peek();

    if (token.type === "punct" && token.value === "(") {
      this.consume();
      const value = this.parseOr();
      this.expect("punct", [")"]);
      return `(${value})`;
    }

    if (token.type === "punct" && token.value === "[") {
      this.consume();
      const values: string[] = [];
      while (!(this.peek().type === "punct" && this.peek().value === "]")) {
        values.push(this.parseOr());
        if (!this.matchPunct(",")) break;
      }
      this.expect("punct", ["]"]);
      if (values.length === 0) {
        throw new Error("Filter lists cannot be empty.");
      }
      return `(${values.join(", ")})`;
    }

    if (token.type === "string") {
      this.consume();
      return escapeSqlLiteral(token.value);
    }

    if (token.type === "number") {
      this.consume();
      return token.value;
    }

    if (token.type === "boolean") {
      this.consume();
      return token.value === "true" ? "TRUE" : "FALSE";
    }

    if (token.type === "null") {
      this.consume();
      return "NULL";
    }

    if (token.type === "identifier") {
      const name = token.value;
      this.consume();

      if (this.matchPunct("(")) {
        throw new Error("Filter functions are not allowed.");
      }

      const resolved = this.allowedColumns.get(name.toLowerCase());
      if (!resolved) {
        throw new Error(`Unknown field in filter: ${name}`);
      }

      return quoteIdentifier(resolved);
    }

    throw new Error(`Unexpected token ${token.type}:${token.value}`);
  }
}

export function buildSafeSqlFilter(
  filter: string | undefined,
  allowedColumns: Iterable<string>,
) {
  const trimmed = (filter || "").trim();
  if (!trimmed) return "";

  const parser = new FilterParser(trimmed, allowedColumns);
  return parser.parse();
}

export function assertReadOnlySqlQuery(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Query cannot be empty.");
  }

  if (/[;]|--|\/\*/.test(query)) {
    throw new Error("Only a single read-only statement is allowed.");
  }

  if (
    !/^(select\b|with\b|explain\b|show\b)/i.test(normalized) ||
    /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|set|reset|vacuum|analyze)\b/i.test(
      normalized,
    )
  ) {
    throw new Error("Only read-only SQL statements are allowed.");
  }
}
