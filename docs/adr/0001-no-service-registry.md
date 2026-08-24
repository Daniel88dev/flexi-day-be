# No central registry or container in front of the service modules

A caller that needs a database function imports it by name from the service module that defines
it. Nothing sits in between — no registry object, no dependency-injection container, no injected
`services` parameter.

We had a registry, `createDBServices()`, and deleted it in August 2026. It was 344 lines in which
every type entry read `typeof theRealFunction` and every factory entry read `theRealFunction`, so
adding one database function meant editing three files. The seam it looked like it offered was
never used: the `DBServices` type was exported but named as a parameter type nowhere, nothing was
injected, and all 67 callers built the object at module level to reach a static import. The tests
that swapped an implementation did it with `vi.mock` on the module path, which works exactly the
same without the hop.

The trade is real and we accept it. A call site reads `getGroup(id)` rather than
`services.group.getGroup(id)`, so it loses the domain qualifier and leans on the function name and
the import block for that context. In exchange, a file's imports name its actual data
dependencies, "go to definition" lands on the implementation, and a new service export is callable
the moment it is written.

## What would reverse this

A **second real adapter** behind the seam: an in-memory store the tests run against, a second
database, a service moving out of process. That is a reason to introduce an interface, and it
should be introduced for the modules that need it rather than for all sixteen at once.

A hypothetical adapter is not a reason, and neither is testability on its own — `vi.mock` already
intercepts the module boundary. If the argument for bringing a registry back is "so we could swap
the implementation", the answer is in the paragraph above: we tried that, and nothing ever swapped.
