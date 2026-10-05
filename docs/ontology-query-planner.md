# Clara AI agent and ontology tools

Every chat question on all six surfaces now enters `ClaraOntology.agent`. Chat intent is never selected by the fixed phrase parser. The AI reads conversation history, account/index coverage, the server clock and the focused source ID, then returns a validated decision. General conversation can be answered directly; private-data answers use tools and cite their evidence.

The browser runs a bounded observe/act loop with three read-only tools:

- `query_ontology`: exact filters, counts, rankings and relation paths over the full account graph. The plan is validated on server and client. Calendar ranges request provider-expanded occurrences.
- `search_evidence`: passage/graph retrieval, optionally restricted by an exact plan. Semantic judgments are made by the AI after reading evidence, rather than rejected by the question grammar. Retrieval is sampled and cannot prove exhaustive semantic counts or absence.
- `read_sources`: reads up to six retrieved, focused or previously cited sources from the current account; text is bounded and truncation is explicit.

The AI sees tool results and can refine the next lookup. It synthesizes the final answer, or asks a specific clarification when identity/information is genuinely missing. At most six tools execute per turn, with bounded provider inputs. Tool errors return to the AI for recovery; account changes interrupt execution. Source facts must cite returned mail/event IDs. Unknown and mutation tools are rejected. The local knowledge panel retains all exact-query matches beyond the AI evidence sample.

The fixed parser remains only as a utility for direct knowledge-panel queries and failure fallback. It does not decide whether a chat question is acceptable. Existing `ontology_plan` API behavior remains compatible.

These tools cannot send/delete mail or mutate calendars. Clara can interpret such requests and draft text, but must state that execution is unavailable instead of claiming success. Attachment content and body text beyond existing synchronization limits are not available. Every chat now depends on an AI provider; free-model quota/availability may prevent a response. This architecture accepts arbitrary language but does not guarantee perfect interpretation or factual accuracy.

Verification covers the complete mocked AI→query→read→answer flow in the actual client, arbitrary conversational wording, general replies without unnecessary tools, follow-up context, exact full-index counts, source sampling, unsafe tool rejection, invalid citations, account isolation, failure recovery and loop/input bounds. Live Google/OpenRouter answers still require real-account verification.

Agent decisions use JSON response mode and a single bounded correction attempt within the original provider deadline. Known optional nulls, a string source type, numeric limit strings and a direct plan argument are normalized without dropping meaningful constraints; missing semantic fields are never guessed. Invalid tool names/actions still fail closed. Diagnostics log fixed validation codes only, never source text or credentials. See https://openrouter.ai/docs/client-sdks/python/api-reference/chat for response_format modes.
