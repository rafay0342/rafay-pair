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
  together: {
    current: "/v1/together-sessions/current",
    create: "/v1/together-sessions",
    respond: (id: string) =>
      `/v1/together-sessions/${encodeURIComponent(id)}/respond`,
    state: (id: string) =>
      `/v1/together-sessions/${encodeURIComponent(id)}/state`,
    end: (id: string) => `/v1/together-sessions/${encodeURIComponent(id)}/end`,
  },
  bloodPressure: {
    list: "/v1/blood-pressure",
    create: "/v1/blood-pressure",
    imports: "/v1/blood-pressure/imports",
    reading: (id: string) => `/v1/blood-pressure/${encodeURIComponent(id)}`,
  },
  ai: {
    memories: "/v1/ai/memories",
    memory: (id: string) => `/v1/ai/memories/${encodeURIComponent(id)}`,
    sessions: "/v1/ai/sessions",
    currentSession: "/v1/ai/sessions/current",
    identityAnnounced: (id: string) =>
      `/v1/ai/sessions/${encodeURIComponent(id)}/identity-announced`,
    endSession: (id: string) => `/v1/ai/sessions/${encodeURIComponent(id)}/end`,
  },
  realtime: {
    ticket: "/v1/realtime/tickets",
    socket: "/v1/realtime",
  },
});
