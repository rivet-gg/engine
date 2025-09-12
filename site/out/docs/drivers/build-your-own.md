# Build Your Own

Each driver implements common interfaces defined by RivetKit, including:

- **ActorDriver**: Manages actor state, lifecycle, and persistence
- **ManagerDriver**: Handles actor discovery, routing, and scaling

## Source Code Locations

Get started by looking at source code for the driver interfaces and existing drivers:

- **Driver Interfaces**
  - **ActorDriver*** [Source Code](https://github.com/rivet-gg/rivetkit/blob/main/packages/core/src/actor/driver.ts)
  - **ManagerDriver*** [Source Code](https://github.com/rivet-gg/rivetkit/blob/main/packages/core/src/manager/driver.ts)
- **Driver Implementations**: [Source Code](https://github.com/rivet-gg/rivetkit/tree/main/packages/core/src/drivers)