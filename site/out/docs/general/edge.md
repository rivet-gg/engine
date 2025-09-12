# Edge Networking

Actors automatically run near your users on your provider's global network.

	At the moment, edge networking is only supported on Rivet Cloud & Cloudflare Workers. More self-hosted platforms are on the roadmap.

## Region selection

### Automatic region selection

By default, actors will choose the nearest region based on the client's location.

Under the hood, Rivet and Cloudflare use [Anycast routing](https://en.wikipedia.org/wiki/Anycast) to automatically find the best location for the client to connect to without relying on a slow manual pinging process.

### Manual region selection

The region an actor is created in can be overridden using region options:

```typescript client.ts
const client = createClient(/* endpoint */);

// Create actor in a specific region
const actor = await client.example.get(
});
```

See [Create  Manage Actors](/actors/communicating-with-actors) for more information.