import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import "./styles.css";
import { AppShell } from "./shell.tsx";
import { FilmsPage } from "./routes/films.tsx";
import { FilmEditor } from "./routes/film-editor.tsx";
import { PagesPage } from "./routes/pages.tsx";
import { ThemePage } from "./routes/theme.tsx";
import { PublishPage } from "./routes/publish.tsx";
import { SetupPage } from "./routes/setup.tsx";

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Navigate to="/films" replace /> },
      { path: "/films", element: <FilmsPage /> },
      { path: "/films/new", element: <FilmEditor /> },
      { path: "/films/:id", element: <FilmEditor /> },
      { path: "/pages", element: <PagesPage /> },
      { path: "/theme", element: <ThemePage /> },
      { path: "/publish", element: <PublishPage /> },
      { path: "/setup", element: <SetupPage /> },
      { path: "*", element: <Navigate to="/films" replace /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
