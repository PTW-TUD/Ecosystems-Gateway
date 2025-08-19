# Publishing connector

A service to push Gaia-X Verifiable Credentials (VC's) to [Pontus-X](https://portal.euprogigant.io/search?sortOrder=desc&text=&sort=nft.created),
[XFSC-Catalog](https://gitlab.eclipse.org/eclipse/xfsc/cat/fc-service) and 
[CredentialEventService](https://gitlab.com/gaia-x/lab/credentials-events-service/-/tree/main?ref_type=heads).

It offers a gRPC API described in [here](./src/_proto/spp_v2.proto).

While the REST API is currently __not__ supported, there is a Http-gRPC gateway you can use.

### Quickstart

The recommended way to run this setup, is to use docker with the provided docker-compose.yml.

*Optional* If you enable gRPC Reflection, you can use Postman or any other graphical user-interface that supports gRPC Reflection to auto discover gRPC methods. This is useful in development environments and highly recommended.

## Installation

```bash
npm install
```

## Configuration

See the example `.env.example` for enviroments variables that can be set.

### General

|Key|Value|Description|
|---|---|---|
|REDIS_ADDRESS|'ip:port'|The address of the redis instance to cache job results. Defaults to `127.0.0.1:6379`|
|ENABLE_GRPC_SERVER|true/false|Enables the gRPC endpoint. Defaults to true|
|GRPC_BIND|'ip:port'|Address the gRPC server listens on. Defaults to `0.0.0.0:5002`|
|ENABLE_GRPC_REFLECTION|true/false|Enables the gRPC reflection for automated rpc discovery|
|ENABLE_GRPC_GATEWAY|true/false|Enables the gRPC<->HTTP Gateway. Defaults to false|
|GRPC_GATEWAY_BIND|'ip:port'|Address the gRPC<->HTTP Gateway listens on. Default: `0.0.0.0:3000`|
|NESTJS_LOG_LEVELS| Comma seperated list of log, error, warn, debug, verbose, fatal|Default is 'log'. See [NestJS documentation](https://docs.nestjs.com/techniques/logger) for more info.|

### Pontus-X

|Key|Value|Description|
|---|---|---|
|NETWORK|PONTUSXTEST, PONTUSXDEV||
|PROVIDER_URL|https://domain.tld|URL of custom Ocean Provider (optional)|
|PROVIDER_ADDRESS|0x...|Public ETH-Address of custom Ocean Provider (optional)|
|PRIVATE_KEY|ECDSA Private Key|Insert any ECDSA Private Key in DER Format of your wallet|
|NAUTILUS_LOG_LEVEL|One out of none, error, warn, log, verbose|Defaults to log|

Mandatory are the values `NETWORK`, `PRIVATE_KEY` (for Pontus-X).

### CES (Gaia-X's Credential Event Service)

|Key|Value|Description|
|---|---|---|
|CES_URL|<https://ces-development.lab.gaia-x.eu/credentials-events>|Is used for the CredentialEventService|

### XFSC Catalog

The XFSC Catalog uses OAuth2.0 password flow. You need to configure client/secret and username/password.

|Key|Value|Description|
|---|---|---|
|XFSC_CAT_HOST_SD_ENDPOINT||self-description endpoint of the XFCS Catalog|
|XFSC_CAT_TOKEN_ENDPOINT||OIDC Token Endpoint.|
|CLIENT_SECRET|||
|CLIENT_ID|||
|XFSC_USERNAME|||
|XFSC_PASSWORD|||

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Build gRPC types

Types for grpc are generated together with the swagger documentation with the tool buf.

```bash
# use @bufbuild/buf
$ npm run proto:gen
```

### Development Setup

If you plan to run this in the development environment, please take a look at the [local development core services](https://gitlab.euprogigant.kube.a1.digital/sebastian.waldbauer/local-development-core-services). After you followed the core services setup, you should be able to run the docker-compose.yml in this repository without any problems. Take a look into the docker-compose.yml to check needed changes.

## License

```
Copyright (C) 2025 PTW | TU Darmstadt, Posedio GmbH, Brinkhaus GmbH

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```