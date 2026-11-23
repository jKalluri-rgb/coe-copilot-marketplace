import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CanvasError,
  createCanvas,
  joinSession
} from "@github/copilot-sdk/extension";


const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const indexPath = path.join(
  __dirname,
  "index.html"
);


/*
 * -------------------------------------------------------------------------
 * FastAPI configuration
 * -------------------------------------------------------------------------
 *
 * Local development:
 *
 *   HEATMAP_API_URL=http://127.0.0.1:8000
 *
 * Production:
 *
 *   HEATMAP_API_URL=https://your-service.example.com
 */

const FASTAPI_URL = (
  process.env.HEATMAP_API_URL ??
  "http://127.0.0.1:8075"
).replace(/\/+$/, "");


/*
 * Each open canvas gets its own local server and state.
 *
 * instanceId ->
 * {
 *   server,
 *   url,
 *   heatmaps
 * }
 */

const instances = new Map();


/*
 * -------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------
 */

function sendJson(
  response,
  status,
  value
) {
  const body = JSON.stringify(value);

  response.writeHead(status, {
    "Content-Type":
      "application/json; charset=utf-8",

    "Content-Length":
      Buffer.byteLength(body),

    "Cache-Control":
      "no-store"
  });

  response.end(body);
}


function sendError(
  response,
  status,
  message
) {
  sendJson(
    response,
    status,
    {
      error: message
    }
  );
}


async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(
    Buffer.concat(chunks).toString("utf8")
  );
}


function getInstance(instanceId) {
  const instance =
    instances.get(instanceId);

  if (!instance) {
    throw new CanvasError(
      "heatmap_feedback_not_open",
      "Open the Heatmap Feedback canvas first."
    );
  }

  return instance;
}


/*
 * -------------------------------------------------------------------------
 * FastAPI calls
 * -------------------------------------------------------------------------
 */

async function fetchHeatmaps() {
  const response = await fetch(
    `${FASTAPI_URL}/heatmaps`,
    {
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `GET /heatmaps failed with HTTP ${response.status}`
    );
  }

  const result = await response.json();

  /*
   * FastAPI contract:
   *
   * {
   *   "heatmaps": [
   *     {
   *       "id": "...",
   *       "name": "..."
   *     }
   *   ]
   * }
   */

  if (!Array.isArray(result.heatmaps)) {
    throw new Error(
      "Invalid /heatmaps response: expected heatmaps array."
    );
  }

  return result.heatmaps;
}


async function sendFeedback(
  feedbacks
) {
  const response = await fetch(
    `${FASTAPI_URL}/submit-feedback`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        Accept:
          "application/json"
      },

      body: JSON.stringify({
        feedbacks
      })
    }
  );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      errorText ||
      `POST /submit-feedback failed with HTTP ${response.status}`
    );
  }

  return response.json();
}


/*
 * -------------------------------------------------------------------------
 * Feedback validation
 * -------------------------------------------------------------------------
 */

function validateFeedback(
  feedbacks,
  heatmaps
) {
  if (!Array.isArray(feedbacks)) {
    throw new Error(
      "feedbacks must be an array."
    );
  }

  /*
   * Ensure feedback corresponds to a heatmap
   * actually loaded by this Canvas.
   */

  const validIds = new Set(
    heatmaps.map(
      heatmap => heatmap.id
    )
  );

  for (const feedback of feedbacks) {

    if (
      !feedback ||
      typeof feedback !== "object"
    ) {
      throw new Error(
        "Invalid feedback record."
      );
    }

    if (!validIds.has(feedback.id)) {
      throw new Error(
        `Unknown heatmap id: ${feedback.id}`
      );
    }

    if (
      !Number.isInteger(feedback.rating) ||
      feedback.rating < 1 ||
      feedback.rating > 5
    ) {
      throw new Error(
        `Rating for ${feedback.id} must be between 1 and 5.`
      );
    }

    if (
      typeof feedback.feedback !==
      "string"
    ) {
      throw new Error(
        `Feedback for ${feedback.id} must be text.`
      );
    }

    if (
      feedback.feedback.length >
      2000
    ) {
      throw new Error(
        `Feedback for ${feedback.id} exceeds 2000 characters.`
      );
    }
  }
}


/*
 * -------------------------------------------------------------------------
 * Local Canvas HTTP server
 * -------------------------------------------------------------------------
 */

async function startServer(
  instanceId
) {

  const instance = {
    server: null,
    url: null,
    heatmaps: []
  };


  const server =
    createServer(
      async (
        request,
        response
      ) => {

        try {

          const requestUrl =
            new URL(
              request.url ?? "/",
              "http://127.0.0.1"
            );


          /*
           * ---------------------------------------------------------------
           * Serve Canvas UI
           * ---------------------------------------------------------------
           */

          if (
            request.method === "GET" &&
            requestUrl.pathname === "/"
          ) {

            const html =
              await readFile(
                indexPath,
                "utf8"
              );

            response.writeHead(
              200,
              {
                "Content-Type":
                  "text/html; charset=utf-8",

                "Cache-Control":
                  "no-store"
              }
            );

            response.end(html);

            return;
          }


          /*
           * ---------------------------------------------------------------
           * GET /api/heatmaps
           *
           * Browser
           *   → extension
           *   → FastAPI /heatmaps
           * ---------------------------------------------------------------
           */

          if (
            request.method === "GET" &&
            requestUrl.pathname ===
              "/api/heatmaps"
          ) {

            const heatmaps =
              await fetchHeatmaps();

            instance.heatmaps =
              heatmaps;

            sendJson(
              response,
              200,
              {
                heatmaps
              }
            );

            return;
          }


          /*
           * ---------------------------------------------------------------
           * POST /api/submit-feedback
           *
           * Browser
           *   → extension
           *   → FastAPI /submit-feedback
           * ---------------------------------------------------------------
           */

          if (
            request.method === "POST" &&
            requestUrl.pathname ===
              "/api/submit-feedback"
          ) {

            const body =
              await readJson(
                request
              );

            validateFeedback(
              body.feedbacks,
              instance.heatmaps
            );

            const result =
              await sendFeedback(
                body.feedbacks
              );

            sendJson(
              response,
              200,
              {
                success: true,
                result
              }
            );

            return;
          }


          sendError(
            response,
            404,
            "Not found."
          );

        } catch (error) {

          console.error(
            "Heatmap Feedback Canvas error:",
            error
          );

          sendError(
            response,
            500,
            error instanceof Error
              ? error.message
              : "Unexpected error."
          );
        }
      }
    );


  instance.server = server;


  await new Promise(
    (resolve, reject) => {

      server.once(
        "error",
        reject
      );

      server.listen(
        0,
        "127.0.0.1",
        resolve
      );
    }
  );


  const address =
    server.address();


  if (
    !address ||
    typeof address === "string"
  ) {
    throw new Error(
      "Could not determine Canvas server port."
    );
  }


  instance.url =
    `http://127.0.0.1:${address.port}/`;


  instances.set(
    instanceId,
    instance
  );


  return instance;
}


/*
 * -------------------------------------------------------------------------
 * Register the Canvas
 * -------------------------------------------------------------------------
 */

await joinSession({

  canvases: [

    createCanvas({

      id:
        "heatmap-feedback-canvas",

      displayName:
        "Heatmap Feedback",

      description:
        "Lets users review heatmap items, provide a 1-to-5 star rating and written feedback for each item, and submit all feedback.",


      /*
       * No input is required to open
       * the Canvas.
       *
       * Heatmaps are loaded from FastAPI.
       */

      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      },


      /*
       * ---------------------------------------------------------------
       * Agent callable actions
       * ---------------------------------------------------------------
       */

      actions: [

        /*
         * Copilot can inspect the items that
         * the user is reviewing.
         */

        {
          name:
            "get_heatmaps",

          description:
            "Get the heatmap items displayed in the Heatmap Feedback canvas.",

          handler:
            async (ctx) => {

              const instance =
                getInstance(
                  ctx.instanceId
                );

              const heatmaps =
                await fetchHeatmaps();

              instance.heatmaps =
                heatmaps;

              return {
                heatmaps
              };
            }
        },


        /*
         * Copilot can also submit feedback
         * if explicitly asked by the user.
         */

        {
          name:
            "submit_feedback",

          description:
            "Submit ratings and written feedback for heatmap items.",

          inputSchema: {

            type: "object",

            properties: {

              feedbacks: {

                type: "array",

                items: {

                  type: "object",

                  properties: {

                    id: {
                      type:
                        "string",

                      description:
                        "Heatmap ID"
                    },

                    rating: {
                      type:
                        "integer",

                      minimum: 1,
                      maximum: 5,

                      description:
                        "Rating between 1 and 5"
                    },

                    feedback: {
                      type:
                        "string",

                      maxLength: 2000,

                      description:
                        "Optional written feedback"
                    }
                  },

                  required: [
                    "id",
                    "rating"
                  ],

                  additionalProperties:
                    false
                }
              }
            },

            required: [
              "feedbacks"
            ],

            additionalProperties:
              false
          },


          handler:
            async (ctx) => {

              const instance =
                getInstance(
                  ctx.instanceId
                );


              /*
               * Ensure we have the current
               * FastAPI collection.
               */

              if (
                instance.heatmaps.length === 0
              ) {

                instance.heatmaps =
                  await fetchHeatmaps();
              }


              const feedbacks =
                ctx.input.feedbacks.map(
                  feedback => ({
                    ...feedback,

                    feedback:
                      feedback.feedback ?? ""
                  })
                );


              validateFeedback(
                feedbacks,
                instance.heatmaps
              );


              const result =
                await sendFeedback(
                  feedbacks
                );


              return {
                success: true,
                result
              };
            }
        }
      ],


      /*
       * ---------------------------------------------------------------
       * Open Canvas
       * ---------------------------------------------------------------
       */

      open:
        async (ctx) => {

          let instance =
            instances.get(
              ctx.instanceId
            );


          if (!instance) {

            instance =
              await startServer(
                ctx.instanceId
              );
          }


          return {

            title:
              "Heatmap Feedback",

            status:
              "Ready for feedback",

            url:
              instance.url
          };
        },


      /*
       * ---------------------------------------------------------------
       * Close Canvas
       * ---------------------------------------------------------------
       */

      onClose:
        async (ctx) => {

          const instance =
            instances.get(
              ctx.instanceId
            );


          if (!instance) {
            return;
          }


          instances.delete(
            ctx.instanceId
          );


          await new Promise(
            resolve => {

              instance.server.close(
                resolve
              );
            }
          );
        }
    })
  ]
});
