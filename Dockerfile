FROM node:22-alpine AS build

RUN apk update && apk add python3 make gcc g++ bash

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
RUN npm ci

# src/generated and src/openapi are committed (npm run proto:gen), and CI checks they are current.
COPY --chown=node:node . .
# Run the build command which creates the production bundle
RUN npm run build
# Set NODE_ENV environment variable
ENV NODE_ENV=production

# Running `npm ci` removes the existing node_modules directory and passing in --omit=dev ensures that only the production dependencies are installed. This ensures that the node_modules directory is as optimized as possible
RUN npm ci --omit=dev && npm cache clean --force

USER node

###################
# PRODUCTION
###################

FROM node:22-alpine AS production

# Copy the bundled code from the build stage to the production image
# package.json marks dist/ as ES modules ("type": "module")
COPY --chown=node:node --from=build /usr/src/app/package.json ./package.json
COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist
COPY --chown=node:node --from=build /usr/src/app/src/openapi ./dist/openapi
COPY --chown=node:node --from=build /usr/src/app/src/_proto_runtime ./dist/_proto_runtime

# Start the server using the production build
CMD [ "node", "dist/main.js" ]
