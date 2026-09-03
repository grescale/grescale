import sql from "../db/db.ts";

// SQL DDL helpers shared by the admin collection APIs: column types, CHECK
// constraints and their synchronization for collection schema fields.

function escapeSqlConstraintLiteral(value: string) {
  return value.replace(/'/g, "''");
}

export function buildSqlConstraintName(
  collectionName: string,
  fieldName: string,
  suffix: string,
) {
  const rawName = `ck_${collectionName}_${fieldName}_${suffix}`
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_");
  return rawName.slice(0, 63);
}

export function buildFieldSqlType(field: any) {
  let safeType = String(field.type || "text")
    .toLowerCase()
    .trim();
  switch (safeType) {
    case "text":
    case "richtext":
    case "email":
    case "url":
    case "file":
      return "TEXT";
    case "number":
      return "NUMERIC";
    case "boolean":
    case "bool":
      return "BOOLEAN";
    case "json":
    case "jsonb":
    case "geolocation":
      return "JSONB";
    case "date":
    case "datetime":
      return "TIMESTAMP WITH TIME ZONE";
    case "date_only":
      return "VARCHAR(10)";
    case "relation":
      if (field.relation_collection) {
        if (!/^[a-zA-Z0-9_]+$/.test(field.relation_collection)) {
          throw new Error(
            `Invalid relation collection: ${field.relation_collection}`,
          );
        }
        return `UUID REFERENCES "${field.relation_collection}"(id)`;
      }
      return "UUID";
    case "uuid":
      return "UUID";
    default:
      return field.type.replace(/[^a-zA-Z0-9_\(\)]/g, "");
  }
}

export function buildFieldChecks(field: any, fieldName: string, tableName: string) {
  const checks: Array<{ suffix: string; expression: string }> = [];
  const type = String(field.type || "text").toLowerCase();

  if (field.required) {
    checks.push({
      suffix: "required",
      expression: `"${fieldName.replace(/"/g, '""')}" IS NOT NULL`,
    });
  }

  if (type === "text" && field.regex) {
    checks.push({
      suffix: "regex",
      expression: `"${fieldName.replace(/"/g, '""')}" ~ '${escapeSqlConstraintLiteral(String(field.regex))}'`,
    });
  }

  if (type === "number") {
    const quoted = `"${fieldName.replace(/"/g, '""')}"`;
    if (field.nonzero) {
      checks.push({ suffix: "nonzero", expression: `${quoted} != 0` });
    }
    if (field.min !== undefined && field.min !== "") {
      checks.push({
        suffix: "min",
        expression: `${quoted} >= ${Number(field.min)}`,
      });
    }
    if (field.max !== undefined && field.max !== "") {
      checks.push({
        suffix: "max",
        expression: `${quoted} <= ${Number(field.max)}`,
      });
    }
  }

  return checks;
}

export function buildFieldColumnDefinition(field: any) {
  const columnName = field.name.replace(/"/g, '""');
  const columnType = buildFieldSqlType(field);
  return `"${columnName}" ${columnType}${field.required ? " NOT NULL" : ""}`;
}

export async function syncFieldSqlConstraints(
  tableName: string,
  field: any,
  previousName?: string,
) {
  const currentName = String(field.name);
  const currentChecks = buildFieldChecks(field, currentName, tableName);
  const namesToDrop = new Set<string>([
    currentName,
    previousName || currentName,
  ]);

  for (const fieldName of namesToDrop) {
    const currentField = String(fieldName);
    for (const suffix of ["required", "regex", "nonzero", "min", "max"]) {
      await sql.unsafe(
        `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${buildSqlConstraintName(tableName, currentField, suffix)}"`,
      );
    }
  }

  for (const check of currentChecks) {
    await sql.unsafe(
      `ALTER TABLE "${tableName}" ADD CONSTRAINT "${buildSqlConstraintName(tableName, currentName, check.suffix)}" CHECK (${check.expression}) NOT VALID`,
    );
  }
}
