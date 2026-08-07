export const apiPaths = Object.freeze({
  auth: {
    csrf: "/v1/auth/csrf",
    register: "/v1/auth/register",
    login: "/v1/auth/login",
    refresh: "/v1/auth/refresh",
    logout: "/v1/auth/logout",
    session: "/v1/auth/me",
  },
  pair: {
    current: "/v1/pairs/current",
    join: "/v1/pairs/join",
  },
  consents: "/v1/consents",
  careRequests: "/v1/care-requests",
  careResponse: (id: string) =>
    `/v1/care-requests/${encodeURIComponent(id)}/respond`,
  privacy: {
    current: "/v1/privacy",
    pause: "/v1/privacy/pause",
    resume: "/v1/privacy/resume",
  },
  realtime: {
    ticket: "/v1/realtime/tickets",
    socket: "/v1/realtime",
  },
});
