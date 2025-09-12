# Architecture

Rivet supports three topologies that define how actors are distributed and scale.

	Each platform configures a default topology appropriate for that environment. In most cases, you can rely on these defaults unless you have specific distribution needs.

## Configuration

```typescript
const config = ;
```

## Types of Topologies

### Standalone

- **How it works**: Runs all actors in a single process
- **When to use**: Development, testing, simple apps with low traffic
- **Limitations**: No horizontal scaling, single point of failure
- **Default on**: Node.js, Bun

### Partition

- **How it works**: Each actor has its own isolated process. Clients connect directly to the actor for optimal performance.
- **When to use**: Production environments needing horizontal scaling
- **Limitations**: Minimal - balanced performance and availability for most use cases
- **Default on**: Rivet, Cloudflare Workers

### Coordinate

- **How it works**: Creates a peer-to-peer network between multiple servers with leader election with multiple actors running on each server. Clients connect to any server and data is transmitted to the leader over a pubsub server.
- **When to use**: High-availability scenarios needing redundancy and failover
- **Limitations**: Added complexity, performance overhead, requires external data source
- **Default on**: _None_

## Choosing a Topology

In most cases, use your platform's default:

1. **Standalone**: Simple, great for development
2. **Partition**: Best scaling & cost for production
3. **Coordinate**: Good for specialized deployment scenarios