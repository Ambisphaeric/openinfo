/** The HTTP surface, as data. phase = when it goes live. Client/workbench generate from this. */
export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  request?: string   // schema $id
  response: string   // schema $id or '<name>[]'
  phase: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7
}

export const Routes: readonly RouteDef[] = [
  { method: 'GET', path: '/health', response: 'Health', phase: 0 },
  { method: 'GET', path: '/contracts', response: 'string[]', phase: 0 },
  { method: 'GET', path: '/contracts/:name', response: 'JsonSchema', phase: 0 },
  { method: 'GET', path: '/flags', response: 'Flag[]', phase: 0 },
  { method: 'PUT', path: '/flags/:key', request: 'Flag', response: 'Flag', phase: 0 },
  { method: 'GET', path: '/fabric', response: 'Fabric', phase: 1 },
  { method: 'PUT', path: '/fabric', request: 'Fabric', response: 'Fabric', phase: 1 },
  { method: 'GET', path: '/fabric/profiles', response: 'FabricProfile[]', phase: 2 },
  { method: 'GET', path: '/fabric/profiles/:id', response: 'FabricProfile', phase: 2 },
  { method: 'PUT', path: '/fabric/profiles/:id', request: 'FabricProfile', response: 'FabricProfile', phase: 2 },
  { method: 'DELETE', path: '/fabric/profiles/:id', response: 'FabricProfile', phase: 2 },
  { method: 'POST', path: '/fabric/profiles/:id/clone', request: 'CloneProfileRequest', response: 'FabricProfile', phase: 2 },
  { method: 'POST', path: '/fabric/profiles/:id/activate', response: 'FabricProfile', phase: 2 },
  { method: 'GET', path: '/fabric/secrets', response: 'SecretRef[]', phase: 2 },
  { method: 'PUT', path: '/fabric/secrets/:ref', request: 'SecretValue', response: 'SecretRef', phase: 2 },
  { method: 'DELETE', path: '/fabric/secrets/:ref', response: 'SecretRef', phase: 2 },
  { method: 'POST', path: '/fabric/test', request: 'Endpoint', response: 'EndpointProbe', phase: 2 },
  { method: 'GET', path: '/fabric/discover', response: 'DiscoverResult', phase: 2 },
  { method: 'GET', path: '/fabric/local/models', response: 'LocalModelStatus[]', phase: 2 },
  { method: 'POST', path: '/fabric/local/download', request: 'LocalDownloadRequest', response: 'LocalModelStatus', phase: 2 },
  { method: 'POST', path: '/capture/:source', request: 'CaptureChunk', response: 'Ack', phase: 1 },
  { method: 'GET', path: '/workspaces', response: 'Workspace[]', phase: 1 },
  { method: 'GET', path: '/sessions', response: 'Session[]', phase: 2 },
  { method: 'POST', path: '/sessions', request: 'StartSessionRequest', response: 'Session', phase: 2 },
  { method: 'POST', path: '/sessions/:id/end', response: 'Session', phase: 2 },
  { method: 'GET', path: '/layouts/surfaces', response: 'Surface[]', phase: 3 },
  { method: 'GET', path: '/layouts/surfaces/:id', response: 'Surface', phase: 2 },
  { method: 'PUT', path: '/layouts/surfaces/:id', request: 'Surface', response: 'Surface', phase: 2 },
  { method: 'GET', path: '/modes', response: 'Mode[]', phase: 2 },
  { method: 'PUT', path: '/modes/:id', request: 'Mode', response: 'Mode', phase: 2 },
  { method: 'GET', path: '/registers', response: 'Register[]', phase: 2 },
  { method: 'GET', path: '/moments', response: 'Moment[]', phase: 2 },
  { method: 'GET', path: '/entities', response: 'Entity[]', phase: 2 },
  { method: 'GET', path: '/relevant', response: 'RelevantEntity[]', phase: 2 },
  { method: 'GET', path: '/drafts', response: 'Draft[]', phase: 2 },
  { method: 'POST', path: '/query', request: 'BlockQuery', response: 'QueryResult', phase: 2 },
  { method: 'POST', path: '/recall', request: 'BlockQuery', response: 'QueryResult', phase: 3 },
  { method: 'POST', path: '/sessions/:id/reroute', request: 'RerouteRequest', response: 'Session', phase: 3 },
  { method: 'GET', path: '/pins', response: 'Pin[]', phase: 3 },
  { method: 'POST', path: '/pins', request: 'Pin', response: 'Pin', phase: 3 },
  { method: 'GET', path: '/ledger', response: 'Commitment[]', phase: 4 },
  { method: 'PUT', path: '/ledger/:id', request: 'Commitment', response: 'Commitment', phase: 4 },
  { method: 'GET', path: '/queue', response: 'QueueStatus', phase: 3 },
] as const
