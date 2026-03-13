import axios from "axios";

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

client.interceptors.request.use((config) => {
  const match = document.cookie.match(/(^| )csrftoken=([^;]+)/);
  const csrfToken = match ? match[2] : null;
  if (csrfToken) config.headers["X-CSRFToken"] = csrfToken;
  if (config.data instanceof FormData) {
    delete config.headers["Content-Type"];
  }
  return config;
});

// When the backend signals that credentials are no longer valid, emit an event
// so that useAuth can clear the user and redirect to the login page.
// DRF returns 401 (NotAuthenticated) when no authenticator succeeds; a stale
// session after a password change is the most common real-world trigger.
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      window.dispatchEvent(new Event("auth:sessionExpired"));
    }
    return Promise.reject(error);
  },
);

export default client;
