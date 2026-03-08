import axios from "axios";

const client = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
  withCredentials: true,
  headers: { "Content-Type": "application/json" },
});

client.interceptors.request.use((config) => {
  const csrfToken = getCookie("csrftoken");
  if (csrfToken) config.headers["X-CSRFToken"] = csrfToken;
  return config;
});

function getCookie(name: "csrftoken"): string | null {
  const match = document.cookie.match(/(^| )csrftoken=([^;]+)/);
  return match ? match[2] : null;
}

export default client;
