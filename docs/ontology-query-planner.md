# Shared ontology query planning

Clara previously returned a generic clarification as soon as a lookup fell outside
the regular-expression grammar. That prevented the AI from interpreting questions
such as `나랑 최근에 가장 많이 메일 주고받은 사람 누구임?`.

All six chat surfaces still use the shared bridge. Known direct lookups run without
an AI call. Other questions use authenticated `POST /api/chat` with
`mode: "ontology_plan"`, conversation context and the browser's timezone. The server
supplies the current local date and the existing free models. It requests a JSON
plan, not an answer computed from sampled mailbox evidence. Both the server and
browser validate this read-only plan against `public/ontology-plan.mjs`.

The browser executes filters over the whole account graph. Supported operations
are lists, counts, grouping/ranking, filtered analysis and specific clarification.
Filters combine dates, Gmail scope/read state, people/project relations and literal
subject/body terms. Multiple entity filters intersect; ambiguous names require an
email address. Lists support date order and a bounded explicit limit.

Aggregation supports people, email domains, projects, dates, months and source
types. Person/domain aggregation is currently email-only. It uses explicit sender,
To and CC edges; excludes the account address, observed SENT aliases and drafts;
deduplicates each message per counterpart; separates sent/received counts; and
retains all source IDs locally. A message with several recipients contributes to
each recipient, so group counts are not additive mailbox counts. Equal cutoff
counts are shown as ties, with at most 50 rows in chat. Source records remain
paginated in the knowledge panel.

Bare “recent” defaults to 30 local calendar days including today, with this
assumption displayed. Explicit dates override it. Filtered analysis queries pass
the exact matched count and a bounded evidence sample to the answer model. Existing
coverage, freshness, calendar-occurrence expansion and citation checks remain.

Plans cannot execute JavaScript/SQL, send/delete mail, mutate calendars, claim
attachment-content analysis, infer verified employers or invent task completion.
Unsupported semantics must ask a specific question. This is a bounded query
language, not proof that an AI will interpret every question correctly. Model
planning still depends on the free provider's availability. On failure the app
reports that no query was executed; direct queries remain available. Real Google
accounts and live provider interpretations require separate verification.

Validation: `npm test`, targeted ESLint, `npx tsc --noEmit`, and the Next production
build. Tests cover full-index ranking beyond 50/60-source samples, recipients and
aliases, ties, homonyms, combined filters, unsupported plans, API authorization,
provider limits and knowledge-panel pagination.
