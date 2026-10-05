# Clara unified evidence ontology v2

## Problem and implemented behavior

Natural-language contact rankings previously fell through a fixed lookup grammar. Clara now maps questions to a validated read-only plan and executes filters, counts and rankings against the complete indexed account graph. AI chooses the plan; JavaScript computes the result. Partial synchronization is explicitly qualified. A model evidence sample is never an exhaustive query result.

The graph shares email-address identities across Gmail and Calendar. It contains Person, Organization (email domain, not verified employer), Email, Thread, Event, Project, Task and Document. Explicit iCalendar UID links invitation emails to calendar series; Message-ID/In-Reply-To links replies. Similar titles and homonymous display names do not merge records. Calendar response status is retained, organizer/attendee duplicates count once, declined invitations are excluded from contact rankings. Attendance metadata denotes an invitation relationship, not proof of actual attendance.

Each relationship carries source IDs, extraction method and assertion status. Rule-generated tasks/projects remain candidates. Task extraction keeps exact text offsets and does not invent assignees, deadlines or completion. Schema validation checks identities, relation domains/ranges, evidence and event intervals. Explicit account-scoped JSON-LD export retains predicates and provenance. This validator is not a complete SHACL implementation and the export is not an OWL reasoner.

Retrieval indexes the available body in overlapping 900-character passages, scores BM25 matches, spreads relevance with weighted personalized PageRank and combines lexical/graph rankings with reciprocal rank fusion. Domain hubs have zero retrieval weight. Graph expansion is bounded to 3,000 nodes/four hops; retrieval is approximate. Directed query paths up to four steps execute against the complete graph with evidence paths. No sampling is used for exact aggregation.

The authenticated chat endpoint rejects a different account's declared context and citations outside the selected source set. Client context remains untrusted: this is an accidental cross-account/stale-context guard, not server verification of every supplied record. The provider receives retrieved evidence for synthesis, while the planner receives the question and clock without mailbox bodies.

## Research basis and limits

- [GraphRAG, Edge et al., 2024](https://arxiv.org/abs/2404.16130): distinguishes broad graph-assisted synthesis from local retrieval. Clara separates complete structured queries from bounded synthesis evidence; it does not implement Leiden communities or community summaries.
- [HippoRAG 2, ICML 2025](https://arxiv.org/abs/2502.14802): motivates passage-aware associative graph retrieval. Clara uses a lightweight lexical/PPR variant, without the paper's embedding and recognition-memory pipeline.
- [STaRK, NeurIPS 2024](https://arxiv.org/abs/2404.13207) and [HybGRAG](https://arxiv.org/abs/2412.16311): motivate combining textual constraints and relational structure. Clara exposes literal body filters and directed relation paths. This implementation has not been evaluated on STaRK and does not reproduce HybGRAG's retriever/critic agent.
- [Text2KGBench](https://arxiv.org/abs/2308.02357): motivates ontology-constrained outputs and separate evaluation of unsupported facts. Clara rejects unknown plan fields/actions and tests candidate status and source provenance.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) and [JSON-LD 1.1](https://www.w3.org/TR/json-ld11/): inform source derivation and the explicit export representation. [SHACL](https://www.w3.org/TR/shacl/) informs shape constraints, but full standards conformance is not claimed.
- [Google Calendar Events](https://developers.google.com/workspace/calendar/api/v3/reference/events) and [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html): define event UID, recurrence and folded calendar content. Only inline calendar MIME is parsed; attachment-only ICS bodies are not downloaded by this change.

## Verification and remaining work

Regression fixtures cover the reported Korean contact-ranking question, complete queries beyond the 60-record model sample, date/timezone boundaries, source scopes, ties, homonyms, account isolation, provider failures, recurrence occurrence windows, exact multi-hop paths, deep body retrieval, invitation/reply links, participant deduplication, declined invitations, scoped export and invalid relation shapes.

These are functional regression results, not proof of world-leading retrieval quality. A production claim requires a consented, independently annotated mailbox/calendar evaluation with retrieval recall/MRR, plan accuracy, grounded-answer accuracy, latency and cost. No real mailbox or live paid model was used in automated tests. Existing synchronization caps mail body text at 24,000 characters; attachment contents are unavailable. Persistent server indexing, incremental Gmail history synchronization, embeddings, entity-alias confirmation, temporal fact retraction and independent benchmark evaluation remain follow-up work.

Validation commands: `npm test`, targeted ESLint, `npx tsc --noEmit`, and `npx next build --webpack --experimental-next-config-strip-types`. The Webpack/config-strip options avoid a Windows sandbox native path restriction; production configuration is unchanged.
