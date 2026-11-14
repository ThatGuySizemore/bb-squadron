// Saved response shapes from Linear's GraphQL/OAuth APIs, with invented identities
// and injected fake credentials. These fixtures contain no workspace records.
export const personalIdentity = {
  data: {
    viewer: { id: "person-1", name: "Fixture Owner" },
    organization: { id: "workspace-1", name: "Fixture Workspace" },
  },
};

export const appIdentity = {
  data: {
    viewer: { id: "app-1", name: "Squadron" },
    organization: { id: "workspace-1", name: "Fixture Workspace" },
  },
};
export const oauthToken = {
  access_token: "fake-app-access", refresh_token: "fake-app-refresh",
  token_type: "Bearer", expires_in: 86399, scope: "read write",
};
