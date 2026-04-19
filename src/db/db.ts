import postgres from "postgres";

let sqlInstance: postgres.Sql<any> | null = null;

if (process.env.DATABASE_URL) {
  sqlInstance = postgres(process.env.DATABASE_URL, {
    max: 10,
    onnotice: () => {},
  });
}

export function initDb(url: string) {
  sqlInstance = postgres(url, { onnotice: () => {}, max: 10 });
  process.env.DATABASE_URL = url;
}

// Export a proxy so modules seamlessly get the actual sql connection once ready
const sqlProxy = new Proxy(function () {}, {
  get: (_, prop) => {
    if (!sqlInstance) throw new Error("Database not initialized yet.");
    const value = Reflect.get(sqlInstance, prop);
    return typeof value === "function" ? value.bind(sqlInstance) : value;
  },
  apply: (_, __, args) => {
    if (!sqlInstance) throw new Error("Database not initialized yet.");
    return (sqlInstance as any)(...args);
  },
}) as unknown as postgres.Sql<any>;

export default sqlProxy;
