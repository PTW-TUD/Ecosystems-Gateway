FROM node:18-alpine AS build

RUN apk update && apk add python3 make gcc g++ bash

WORKDIR /usr/src/app

COPY --chown=node:node package*.json ./
RUN npm ci

COPY --chown=node:node buf.yaml buf.gen.yaml ./
COPY --chown=node:node src/_proto ./src/_proto
RUN npx buf dep update && npx buf generate

COPY --chown=node:node . .
# Run the build command which creates the production bundle
RUN npm run build
# Set NODE_ENV environment variable
ENV NODE_ENV=production

# Running `npm ci` removes the existing node_modules directory and passing in --only=production ensures that only the production dependencies are installed. This ensures that the node_modules directory is as optimized as possible
RUN npm ci --only=production && npm cache clean --force

USER node

###################
# PRODUCTION
###################

FROM node:18-alpine AS production

# Copy the bundled code from the build stage to the production image
COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist
COPY --chown=node:node --from=build /usr/src/app/src/openapi ./dist/openapi
COPY --chown=node:node --from=build /usr/src/app/src/_proto_runtime ./dist/_proto_runtime

# Start the server using the production build
CMD [ "node", "dist/main.js" ]
