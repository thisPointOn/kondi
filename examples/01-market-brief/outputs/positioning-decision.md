# Positioning decision (analysis) — completed

> Analysis step (manager-only) picks ONE opportunity and commits to a positioning.

**SUMMARY:**  
The consultants reviewed the project structure and identified three main strategic directions: (1) deepening the core LLM orchestration capabilities, (2) investing heavily in a refined user‑experience/dashboard, and (3) leveraging the existing plugin registry to create an ecosystem of third‑party extensions. Opinions were split: the core‑focus group stressed stability and performance; the UX group argued that a polished interface would drive adoption; the ecosystem group highlighted the extensibility points already present in `src/plugins/registry.js` and the network‑effect potential of a marketplace.

**DECISION:**  
We will pursue the **plugin marketplace** opportunity – building a curated marketplace where developers can publish, discover, and install Kondi plugins that extend the orchestrator’s functionality (e.g., new LLM agents, data connectors, UI widgets).

**RATIONALE:**  
- The plugin registry already exists (`src/plugins/registry.js`), indicating the architecture is designed for extensibility; investing here yields high leverage with relatively low engineering overhead.  
- A marketplace creates a defensible network effect: more plugins attract more users, which in turn incentivizes more plugin authors.  
- It addresses a clear gap identified in the enrichment doc: users want domain‑specific capabilities without forking the core product.  
- Compared to a pure core‑performance push, the marketplace offers differentiated value that is harder for competitors to copy quickly.  
- Compared to a UX‑first approach, the marketplace delivers tangible functional value that can be measured via adoption metrics, while a better UI can be iterated on later.

**REJECTED ALTERNATIVES:**  
1. **Core LLM orchestration enhancements** – Important but incremental; performance gains are quickly matched by competitors and do not create new revenue streams.  
2. **Refined UI/dashboard** – Improves usability but does not unlock new capabilities; the current UI is sufficient for early adopters, and UI work can be deferred until the ecosystem proves demand.  
3. **AI‑powered code‑generation feature** – Would require significant research investment and faces uncertain market fit; the plugin approach lets the community experiment with such features first.

**RISKS:**  
1. **Adoption risk** – Developers may not contribute plugins if incentives or visibility are insufficient.  
2. **Quality & security risk** – Third‑party plugins could introduce bugs, performance issues, or security vulnerabilities that affect the core platform’s reputation.  
3. **Governance overhead** – Curating, reviewing, and maintaining marketplace standards will require ongoing process and tooling investment.

**ACCEPTANCE CRITERIA (how we’ll know the work is correct):**  
- **Launch metric:** Within 8 weeks, the marketplace hosts at least 10 vetted plugins from external contributors.  
- **Engagement metric:** After launch, ≥30% of active Kondi installations have installed at least one third‑party plugin within the first month.  
- **Quality metric:** No severity‑1 security or stability incidents attributed to marketplace plugins in the first 60 days post‑launch.  
- **Revenue/feedback metric:** Collect qualitative feedback indicating that plugins enable users to accomplish tasks they could not before, and track any premium/plugin‑revenue generated (if monetization is pursued).
