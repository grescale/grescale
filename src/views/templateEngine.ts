import Handlebars from "handlebars";
import { readFile } from "fs/promises";
import { join } from "path";

const TEMPLATES_DIR = join(import.meta.dir, "templates");
const compiledTemplates = new Map<string, Handlebars.TemplateDelegate>();

// Register built-in helpers
function registerHelpers() {
  Handlebars.registerHelper("eq", (a: any, b: any) => a === b);
  Handlebars.registerHelper("ne", (a: any, b: any) => a !== b);
  Handlebars.registerHelper("lt", (a: any, b: any) => a < b);
  Handlebars.registerHelper("lte", (a: any, b: any) => a <= b);
  Handlebars.registerHelper("gt", (a: any, b: any) => a > b);
  Handlebars.registerHelper("gte", (a: any, b: any) => a >= b);
  Handlebars.registerHelper("and", (...args: any[]) => {
    const conditions = args.slice(0, -1);
    return conditions.every((c) => c);
  });
  Handlebars.registerHelper("or", (...args: any[]) => {
    const conditions = args.slice(0, -1);
    return conditions.some((c) => c);
  });
  Handlebars.registerHelper("not", (value: any) => !value);
  Handlebars.registerHelper("includes", (array: any[], item: any) => {
    return Array.isArray(array) && array.includes(item);
  });
  Handlebars.registerHelper("json", (context: any) => {
    return JSON.stringify(context);
  });
  Handlebars.registerHelper("add", (a: number, b: number) => a + b);
  Handlebars.registerHelper("subtract", (a: number, b: number) => a - b);
  Handlebars.registerHelper("multiply", (a: number, b: number) => a * b);
  Handlebars.registerHelper("divide", (a: number, b: number) => a / b);
}

/**
 * Load and compile a Handlebars template
 * @param templateName - Template file name without extension
 * @returns Compiled template function
 */
async function getTemplate(templateName: string) {
  // Register helpers on first call
  if (compiledTemplates.size === 0) {
    registerHelpers();
  }

  if (compiledTemplates.has(templateName)) {
    return compiledTemplates.get(templateName)!;
  }

  const templatePath = join(TEMPLATES_DIR, `${templateName}.hbs`);
  const templateContent = await readFile(templatePath, "utf-8");
  const compiled = Handlebars.compile(templateContent);
  compiledTemplates.set(templateName, compiled);
  return compiled;
}

export async function renderTemplate(
  templateName: string,
  data: Record<string, any> = {},
) {
  const template = await getTemplate(templateName);
  return template(data);
}
