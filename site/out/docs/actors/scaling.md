# Scaling & Concurrency

This document covers how actors are able to scale better than traditional applications & provides tips on architecting your actors.

## How actors scale

Actors scale by design through these key properties:

| Property                             | Description                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Independent State**                | Each actor manages its own private data separately from other actors, so they never conflict with each other when running at the same time (i.e. using locking mechanisms).                                                                                                                     |
| **Action- & Event-Based Communication** | Actors communicate through asynchronous [actions](/docs/actors/actions) or [events](/docs/actors/events), making it easy to distribute them across different machines.                                                                                                                                               |
| **Location Transparency**            | Unlike traditional servers, actors don't need to know which machine other actors are running on in order to communicate with each other. They can run on the same machine, across a network, and across the world. Actors handle the network routing for you under the hood.                    |
| **Horizontal Scaling**               | Actors distribute workload by splitting responsibilities into small, focused units. Since each actor handles a limited scope (like a single user, document, or chat room), the system automatically spreads load across many independent actors rather than concentrating it in a single place. |

## Tips for architecting actors for scale

Here are key principles for architecting your actor system:

**Single Responsibility**

- Each actor should represent one specific entity or concept from your application (e.g., `User`, `Document`, `ChatRoom`).
- This makes your system scale better, since actors have small scopes and do not conflict with each other.

**State Management**

- Each actor owns and manages only its own state
- Use [actions](/docs/actors/actions) to request data from other actors
- Keep state minimal and relevant to the actor's core responsibility

**Granularity Guidelines**

- Too coarse: Actors handling too many responsibilities become bottlenecks
- Too fine: Excessive actors create unnecessary communication overhead
- Aim for actors that can operate independently with minimal cross-actor communication

### Examples

**Good actor boundaries**

- `User`: Manages user profile, preferences, and authentication
- `Document`: Handles document content, metadata, and versioning
- `ChatRoom`: Manages participants and message history

**Poor actor boundaries**

- `Application`: Too broad, handles everything
- `DocumentWordCount`: Too granular, should be part of DocumentActor