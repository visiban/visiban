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
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 403 &&
      error.response?.data?.detail === "Authentication credentials were not provided."
    ) {
      window.dispatchEvent(new Event("auth:sessionExpired"));
    }
    return Promise.reject(error);
  },
);

export default client;
