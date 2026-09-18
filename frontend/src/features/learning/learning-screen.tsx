/** Static technology guide. No account APIs or execution effects run on this screen. */
import { Activity, Code2, Database, Zap } from "lucide-react";
/** Explain real component boundaries without implying research can dispatch live orders. */
export function LearningScreen() {
  return (
    <section className="learning-grid">
      {[
        [
          Code2,
          "01 / INTERFACE",
          "Next.js + TypeScript",
          "React renders this workspace. TypeScript describes the API data so the editor catches mismatched fields. Tailwind handles utility styles.",
          "frontend/src/features/workspace/workspace-app.tsx",
        ],
        [
          Zap,
          "02 / API",
          "Node.js + Express + TypeScript",
          "Validates requests, checks the account session, and enforces permissions. Connection credentials are submitted by the form; broker sessions remain on the server.",
          "backend/main.ts",
        ],
        [
          Database,
          "03 / STORAGE",
          "SQL + PostgreSQL",
          "PostgreSQL stores your workspace locally and on AWS. Owner-scoped parameterized queries isolate accounts; numbered migrations preserve existing data.",
          "backend/database.ts",
        ],
        [
          Activity,
          "04 / EXECUTION",
          "Broker execution service",
          "The server validates risk limits and explicit authorization before sending live orders. Research results never place orders automatically.",
          "backend/live/execution.ts",
        ],
      ].map(([Icon, label, title, description, file]) => {
        const Symbol = Icon as typeof Code2;
        return (
          <article className="panel learning-card" key={String(title)}>
            <Symbol size={23} />
            <span className="eyebrow">{String(label)}</span>
            <h3>{String(title)}</h3>
            <p>{String(description)}</p>
            <code>{String(file)}</code>
          </article>
        );
      })}
    </section>
  );
}
