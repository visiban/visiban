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
  return config;
});

export default client;
