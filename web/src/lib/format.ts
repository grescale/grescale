// Cell value formatting mirroring the legacy HTMX records grid.

export type CellKind = "empty" | "boolean" | "number" | "date" | "json" | "text";

export interface CellDisplay {
  kind: CellKind;
  text: string;
  bool?: boolean;
  date?: string;
  time?: string;
  title?: string;
}

const DATE_COL_SUFFIX = /(_at|_date)$/;

export function formatCellValue(val: unknown, colName: string): CellDisplay {
  if (val === null || val === undefined) {
    return { kind: "empty", text: "—" };
  }

  if (typeof val === "boolean") {
    return { kind: "boolean", text: val ? "true" : "false", bool: val };
  }

  if (typeof val === "number") {
    return { kind: "number", text: val.toLocaleString() };
  }

  if (typeof val === "object") {
    const jsonText = JSON.stringify(val);
    const clipped =
      jsonText.length > 40 ? `${jsonText.substring(0, 40)}…` : jsonText;
    return { kind: "json", text: clipped, title: jsonText };
  }

  const strVal = String(val);

  if (strVal === "true" || strVal === "false") {
    return { kind: "boolean", text: strVal, bool: strVal === "true" };
  }

  if (
    DATE_COL_SUFFIX.test(colName) &&
    (strVal.includes("T") || strVal.includes(" "))
  ) {
    const date = new Date(strVal);
    if (!isNaN(date.getTime())) {
      return {
        kind: "date",
        text: strVal,
        date: date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        time: date.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      };
    }
  }

  const clipped =
    strVal.length > 60 ? `${strVal.substring(0, 60)}…` : strVal;
  return { kind: "text", text: clipped, title: strVal };
}

export function shortId(id: unknown): string {
  const full = String(id ?? "");
  if (full.includes("-")) return `${full.split("-")[0]}…`;
  if (full.length > 8) return `${full.substring(0, 8)}…`;
  return full;
}

// Order columns like the legacy UI: id first, user columns, system timestamps last.
export function orderColumns(columns: string[]): string[] {
  const system = ["created_at", "updated_at"];
  const idCol = columns.includes("id") ? ["id"] : [];
  const tail = system.filter((c) => columns.includes(c));
  const middle = columns.filter(
    (c) => c !== "id" && !system.includes(c),
  );
  return [...idCol, ...middle, ...tail];
}

// Columns never shown in the grid (sensitive/system material).
const HIDDEN_COLUMNS = new Set(["password", "password_hash", "token_key"]);

export function visibleColumns(columns: string[]): string[] {
  return orderColumns(columns.filter((c) => !HIDDEN_COLUMNS.has(c)));
}
