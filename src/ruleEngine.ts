export interface RuleEvaluationContext {
  user?: any;
  collectionName: string;
  collection?: Record<string, any>;
  record?: Record<string, any>;
  body?: Record<string, any>;
  query?: Record<string, any>;
  method?: string;
  path?: string;
}

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

function isObjectLike(value: any) {
  return value !== null && typeof value === "object";
}

function hasOwn(target: any, key: string) {
  return Object.prototype.hasOwnProperty.call(target || {}, key);
}

function toText(value: any) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.join(",");
  if (isObjectLike(value)) return JSON.stringify(value);
  return String(value);
}

function toNumber(value: any) {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function toComparable(value: any) {
  const numeric = toNumber(value);
  if (!Number.isNaN(numeric)) return numeric;
  return toText(value);
}

function truthy(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (isObjectLike(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

function resolvePath(context: RuleEvaluationContext, rawPath: string) {
  const path = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return undefined;

  const root = segments[0];
  const rest = segments.slice(1);

  let current: any;
  if (root === "request") {
    current = {
      auth: context.user,
      body: context.body,
      query: context.query,
      method: context.method,
      path: context.path,
      collection: {
        name: context.collectionName,
        ...(context.collection || {}),
      },
    };
  } else if (root === "auth") {
    current = context.user;
  } else if (root === "body") {
    current = context.body;
  } else if (root === "query") {
    current = context.query;
  } else if (root === "record") {
    current = context.record;
  } else if (root === "collection") {
    current = { name: context.collectionName, ...(context.collection || {}) };
  } else if (root === "method") {
    current = context.method;
  } else if (root === "path") {
    current = context.path;
  } else {
    current = undefined;
  }

  if (rest.length === 0) return current;

  for (const segment of rest) {
    if (current === null || current === undefined) return undefined;
    current = current[segment];
  }

  return current;
}

function resolveIdentifier(context: RuleEvaluationContext, name: string) {
  const lowered = name.toLowerCase();
  if (lowered === "true") return true;
  if (lowered === "false") return false;
  if (lowered === "null") return null;

  if (name.startsWith("@") || name.includes(".")) {
    return resolvePath(context, name);
  }

  if (context.body && hasOwn(context.body, name)) return context.body[name];
  if (context.record && hasOwn(context.record, name))
    return context.record[name];
  if (context.user && hasOwn(context.user, name)) return context.user[name];
  if (context.query && hasOwn(context.query, name)) return context.query[name];
  if (context.collection && hasOwn(context.collection, name)) {
    return context.collection[name];
  }

  return undefined;
}

function compareContains(left: any, right: any) {
  if (Array.isArray(left)) {
    return left.some((item) => item === right);
  }
  if (Array.isArray(right)) {
    return right.some((item) => item === left);
  }
  const leftText = toText(left).toLowerCase();
  const rightText = toText(right).toLowerCase();
  return leftText.includes(rightText);
}

function compareStartsWith(left: any, right: any) {
  return toText(left).toLowerCase().startsWith(toText(right).toLowerCase());
}

function compareEndsWith(left: any, right: any) {
  return toText(left).toLowerCase().endsWith(toText(right).toLowerCase());
}

function compareMatches(left: any, right: any, flags = "i") {
  try {
    const regex = new RegExp(toText(right), flags);
    return regex.test(toText(left));
  } catch {
    return false;
  }
}

function compareIn(left: any, right: any) {
  if (Array.isArray(right)) {
    return right.some((item) => item === left);
  }
  if (typeof right === "string") {
    return right.toLowerCase().includes(toText(left).toLowerCase());
  }
  return false;
}

function coalesceValues(values: any[]) {
  for (const value of values) {
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return null;
}

function callFunction(name: string, args: any[]) {
  const fn = name.toLowerCase();
  switch (fn) {
    case "exists":
      return args.length > 0 && truthy(args[0]);
    case "len":
    case "length": {
      const value = args[0];
      if (value === null || value === undefined) return 0;
      if (typeof value === "string" || Array.isArray(value))
        return value.length;
      if (isObjectLike(value)) return Object.keys(value).length;
      return toText(value).length;
    }
    case "lower":
      return toText(args[0]).toLowerCase();
    case "upper":
      return toText(args[0]).toUpperCase();
    case "trim":
      return toText(args[0]).trim();
    case "contains":
      return compareContains(args[0], args[1]);
    case "startswith":
      return compareStartsWith(args[0], args[1]);
    case "endswith":
      return compareEndsWith(args[0], args[1]);
    case "matches":
      return compareMatches(args[0], args[1], args[2] ? toText(args[2]) : "i");
    case "coalesce":
      return coalesceValues(args);
    default:
      throw new Error(`Unknown rule function: ${name}`);
  }
}

function tokenize(source: string): Token[] {
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

class RuleParser {
  private tokens: Token[];
  private index = 0;

  constructor(
    private source: string,
    private context: RuleEvaluationContext,
  ) {
    this.tokens = tokenize(source);
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

  private parseOr(): any {
    let left = this.parseAnd();
    while (this.matchOperator("||") || this.matchOperator("or")) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): any {
    let left = this.parseUnary();
    while (this.matchOperator("&&") || this.matchOperator("and")) {
      const right = this.parseUnary();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseUnary(): any {
    if (this.matchOperator("!") || this.matchOperator("not")) {
      return !truthy(this.parseUnary());
    }
    return this.parseComparison();
  }

  private parseComparison(): any {
    let left = this.parsePrimary();
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

    switch (op) {
      case "=":
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case ">":
        return toComparable(left) > toComparable(right);
      case ">=":
        return toComparable(left) >= toComparable(right);
      case "<":
        return toComparable(left) < toComparable(right);
      case "<=":
        return toComparable(left) <= toComparable(right);
      case "~":
        return compareContains(left, right);
      case "!~":
        return !compareContains(left, right);
      case "in":
        return compareIn(left, right);
      default:
        return false;
    }
  }

  private parsePrimary(): any {
    const token = this.peek();

    if (token.type === "punct" && token.value === "(") {
      this.consume();
      const value = this.parseOr();
      this.expect("punct", [")"]);
      return value;
    }

    if (token.type === "punct" && token.value === "[") {
      this.consume();
      const values: any[] = [];
      while (!(this.peek().type === "punct" && this.peek().value === "]")) {
        values.push(this.parseOr());
        if (!this.matchPunct(",")) break;
      }
      this.expect("punct", ["]"]);
      return values;
    }

    if (token.type === "string") {
      this.consume();
      return token.value;
    }

    if (token.type === "number") {
      this.consume();
      return Number(token.value);
    }

    if (token.type === "boolean") {
      this.consume();
      return token.value === "true";
    }

    if (token.type === "null") {
      this.consume();
      return null;
    }

    if (token.type === "identifier") {
      const name = token.value;
      this.consume();
      if (this.matchPunct("(")) {
        const args: any[] = [];
        while (!(this.peek().type === "punct" && this.peek().value === ")")) {
          args.push(this.parseOr());
          if (!this.matchPunct(",")) break;
        }
        this.expect("punct", [")"]);
        return callFunction(name, args);
      }
      return resolveIdentifier(this.context, name);
    }

    throw new Error(`Unexpected token ${token.type}:${token.value}`);
  }
}

export function satisfiesRule(
  rule: string | null,
  context: RuleEvaluationContext,
) {
  if (context.user && context.user.type === "admin") {
    return true;
  }

  if (rule === null) {
    return false;
  }

  const trimmedRule = rule.trim();
  if (trimmedRule === "") {
    return true;
  }

  try {
    const parser = new RuleParser(trimmedRule, context);
    return truthy(parser.parse());
  } catch {
    return false;
  }
}
