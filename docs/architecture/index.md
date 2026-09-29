# Architecture

Technical documentation for developers and self-hosters.

| Document | Description |
|---|---|
| [Overview](overview.md) | System diagram, full tech stack, REST and WebSocket request lifecycles |
| [Data Model](data-model.md) | Database schema, key models, and their relationships |
| [Deployment](deployment.md) | Docker Compose, production images, Helm chart for Kubernetes |
| [Scaling](scaling.md) | Single-server ceilings, when to scale each component, and the recommended scaling sequence |
| [Service Layer](service-layer.md) | Where board-mutation invariants live, why they are not in the views, and the write paths that still bypass them |
| [API Versioning](api-versioning.md) | The `/api/v1/` backward-compatibility contract and how deprecation works |
| [Open-Core Boundary](open-core-boundary.md) | OSS vs Enterprise classification for every feature area, and the extension points enterprise plugs into |
| [Technology Decisions](decisions.md) | Technology choices and the reasoning behind each decision |
