import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";

export const server = setupServer(
  http.post(
    "https://api.github.com/repos/bulai0408/Asspp/actions/workflows/upstream-signed-ios.yml/dispatches",
    () => new HttpResponse(null, { status: 204 }),
  ),
);
