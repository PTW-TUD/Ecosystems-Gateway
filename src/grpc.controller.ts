import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { PontusxService } from './pontusx/pontusx.service.js';
import { XfscService } from './xfsc/xfsc.service.js';
import {
  CreateOfferingRequest,
  CreateOfferingResponse,
  UpdateOfferingRequest,
  UpdateOfferingResponse,
  UpdateOfferingLifecycleRequest,
  UpdateOfferingLifecycleResponse,
  GetOfferingRequest,
  GetOfferingResponse,
  GetComputeToDataResultResponse,
  CreateComputeToDataResultRequest,
  CreateComputeToDataRequest,
  ComputeToDataResponse,
  AccessServiceRequest,
  AccessServiceResponse,
  ComputeToDataStatusRequest,
  ComputeToDataStatusResponse,
  QueryOfferingsRequest,
  QueryOfferingsResponse,
} from './generated/spp_v3.js';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import {
  extractRpcError,
  isRpcException,
  mapToRpcException,
} from './grpc-error.util.js';
import { LifecycleStates } from '@deltadao/nautilus';
import {
  CtdToDcpStateMap,
  getCtdStatusText,
  isCtdStatusCode,
} from './pontusx/utility.js';
import { redactForLog } from './logging.js';

// Errors caused by the request: logged as warnings, without a stack trace.
const CLIENT_ERROR_CODES = new Set<number>([
  GrpcStatusCode.INVALID_ARGUMENT,
  GrpcStatusCode.NOT_FOUND,
  GrpcStatusCode.ALREADY_EXISTS,
  GrpcStatusCode.PERMISSION_DENIED,
  GrpcStatusCode.UNAUTHENTICATED,
  GrpcStatusCode.FAILED_PRECONDITION,
  GrpcStatusCode.OUT_OF_RANGE,
  GrpcStatusCode.UNIMPLEMENTED,
]);

@Controller('grpc')
export class GrpcController {
  private readonly logger = new Logger(GrpcController.name);

  constructor(
    private readonly pontusxService: PontusxService,
    private readonly xfscService: XfscService,
  ) {}

  private async runRpc<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    this.logger.log(`[${method}] ↘ request`);

    try {
      const res = await fn();
      this.logger.log(`[${method}] ↗ ok in ${Date.now() - start}ms`);
      return res;
    } catch (err: any) {
      // Pass-through if already RpcException, map unknown errors
      const exception = isRpcException(err)
        ? err
        : mapToRpcException(err, {
            service: 'grpc.controller',
            where: method,
            defaultCode: GrpcStatusCode.INTERNAL,
          });
      this.logRpcError(method, Date.now() - start, exception);
      throw exception;
    }
  }

  private logRpcError(method: string, ms: number, exception: RpcException) {
    const p = extractRpcError(exception);
    const codeName = p.code != null ? GrpcStatusCode[p.code] : 'UNKNOWN';
    // the id of the nautilus operation, as its log lines carry it
    const opId = p.metadata?.get?.('x-nautilus-op-id')?.[0];
    const message = `[${method}] ✗ ${codeName} in ${ms}ms: ${p.message}${
      opId ? ` (nautilus op ${opId})` : ''
    }`;
    if (p.code != null && CLIENT_ERROR_CODES.has(p.code)) {
      this.logger.warn(message);
    } else {
      this.logger.error(message, exception.stack);
    }
  }

  // The request without credentials (data source headers, userdata), at verbose level.
  private logRequest(method: string, data: unknown) {
    this.logger.debug(`grpc method ${method} called`);
    if (Logger.isLevelEnabled('verbose')) {
      this.logger.verbose(redactForLog(data));
    }
  }

  @GrpcMethod('ecosystemsgateway')
  async createOffering(
    data: CreateOfferingRequest,
  ): Promise<CreateOfferingResponse> {
    this.logRequest('CreateOffering', data);

    const results = [];
    for (const offering of data.offerings) {
      if (offering.pontusxOffering !== undefined) {
        const result = await this.runRpc('createOffering', () =>
          this.pontusxService.publishAsset(offering.pontusxOffering),
        );
        if (result) {
          results.push(result.ddo.id);
        }
      } else {
        try {
          const VP = JSON.parse(offering.xfscOffering.vp);
          const token = await this.xfscService.getToken();
          const singleResult = await this.xfscService.publish(token, VP);
          results.push(singleResult);
        } catch (err) {
          this.logger.error(
            'Error occured when trying to get the Token needed for the XFSC catalogue: ',
            err,
          );
          throw err;
        }
      }
    }

    if (results.length) {
      return {
        id: results,
        debugInformation: undefined,
      };
    }
  }

  @GrpcMethod('ecosystemsgateway')
  async updateOffering(
    data: UpdateOfferingRequest,
  ): Promise<UpdateOfferingResponse> {
    this.logRequest('UpdateOffering', data);

    const ces_results: Array<string> = [];
    const results = [];
    const ids = [];
    for (const offering of data.offerings) {
      if (offering.pontusxUpdateOffering !== undefined) {
        const result = await this.runRpc('updateOffering', () =>
          this.pontusxService.updateOffering(offering),
        );
        if (result) {
          ces_results.push(result.ces);
          ids.push(result.pontus.ddo.id);
          results.push(result.pontus);
        }
      } else {
        // XFSC
        const token = await this.xfscService.getToken();
        const hash = offering.xfscUpdateOffering.hash;
        const VP = JSON.parse(offering.xfscUpdateOffering.vp);

        const result = await this.xfscService.update(token, hash, VP);

        return {
          id: [result],
          locations: undefined,
          debugInformation: undefined,
        };
      }
    }

    if (ces_results.length || results.length) {
      return {
        id: ids,
        locations: ces_results,
        debugInformation: { results },
      };
    }

    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal Error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async updateOfferingLifecycle(
    data: UpdateOfferingLifecycleRequest,
  ): Promise<UpdateOfferingLifecycleResponse> {
    this.logRequest('UpdateOfferingLifecycle', data);
    const results = [];
    const ids = [];
    for (const offering of data.offerings) {
      if (offering.pontusxUpdateOfferingLifecycle !== undefined) {
        const result = await this.runRpc('updateOfferingLifecycle', () =>
          this.pontusxService.setState(
            offering.pontusxUpdateOfferingLifecycle.did,
            offering.pontusxUpdateOfferingLifecycle
              .to as unknown as LifecycleStates, // is there a better way?
          ),
        );
        if (result) {
          results.push(result);
          ids.push(offering.pontusxUpdateOfferingLifecycle.did);
        }
      } else {
        throw new RpcException({
          code: GrpcStatusCode.UNIMPLEMENTED,
          message: 'xfscUpdateOfferingLifecycle is currently not implemented',
        });
        //xfscUpdateOffering because of oneof
        //missing
      }
    }

    if (results.length) {
      return {
        id: ids,
        debugInformation: { results },
      };
    }

    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal Error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async getComputeToDataResult(
    data: CreateComputeToDataResultRequest,
  ): Promise<GetComputeToDataResultResponse> {
    this.logRequest('GetComputeToDataResult', data);
    const result = await this.runRpc('getComputeToDataResult', () =>
      this.pontusxService.getComputeToDataResult(
        data.jobId,
        data.computeToDataReturnType,
        data.jobIndex,
      ),
    );

    if (result) {
      return result;
    }

    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal Error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async getOffering(data: GetOfferingRequest): Promise<GetOfferingResponse> {
    this.logRequest('GetOffering', data);

    const result: string[] = [];
    await Promise.all(
      data.offerings.map(async (offering) => {
        if (offering.pontusxOffering !== undefined) {
          const pontusxResult = await this.runRpc('getPontusxOffering', () =>
            this.pontusxService.getOffering(offering.pontusxOffering.did),
          );
          if (pontusxResult) {
            result.push(JSON.stringify(pontusxResult));
          }
        }

        if (offering.xfscOffering !== undefined) {
          const xfscResult = await this.runRpc('getXfscOffering', () =>
            this.xfscService.getOffering(
              offering.xfscOffering.did,
              offering.xfscOffering.issuer,
              offering.xfscOffering.name,
            ),
          );
          if (xfscResult) {
            result.push(...xfscResult);
          }
        }
      }),
    );

    if (result.length) {
      return {
        offerings: result,
        debugInformation: undefined,
      };
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async queryOfferings(
    data: QueryOfferingsRequest,
  ): Promise<QueryOfferingsResponse> {
    this.logRequest('QueryOfferings', data);

    const result: string[] = [];
    let resultTotal: number = 0;

    if (data.query.pontusxQuery !== undefined) {
      const queryResult = await this.runRpc('queryOfferings', () =>
        this.pontusxService.queryOfferings(
          data.query.pontusxQuery.did,
          data.query.pontusxQuery.name,
          data.query.pontusxQuery.description,
          data.query.pontusxQuery.author,
          data.query.pontusxQuery.metadataType,
          data.query.pontusxQuery.serviceType,
          data.query.pontusxQuery.page,
          data.query.pontusxQuery.pageSize,
        ),
      );
      const resultOfferings = queryResult[0];
      for (const asset of resultOfferings) {
        result.push(JSON.stringify(asset));
      }
      resultTotal = queryResult[1];
    } else {
      throw new RpcException({
        code: GrpcStatusCode.UNIMPLEMENTED,
        message: 'xfscQuery is currently not implemented',
      });
    }
    // a search without matches is an answer, not an error
    return {
      offerings: result,
      total: resultTotal,
    };
  }

  @GrpcMethod('ecosystemsgateway')
  async accessService(
    data: AccessServiceRequest,
  ): Promise<AccessServiceResponse> {
    this.logRequest('AccessService', data);

    let result: string;

    if (data.service.pontusxService !== undefined) {
      result = await this.runRpc('accessService', () =>
        this.pontusxService.accessService(
          data.service.pontusxService.did,
          data.service.pontusxService.serviceId,
          data.service.pontusxService.fileIndex,
          data.service.pontusxService.userdata,
        ),
      );
    } else {
      throw new RpcException({
        code: GrpcStatusCode.UNIMPLEMENTED,
        message: 'xfscAccess is currently not supported',
      });
    }
    if (result) {
      return {
        id: data.service.pontusxService.did,
        accessUrl: result,
      };
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async RunComputeToDataJob(
    data: CreateComputeToDataRequest,
  ): Promise<ComputeToDataResponse> {
    this.logRequest('RunComputeToDataJob', data);
    const result = await this.runRpc('requestComputeToData', () =>
      this.pontusxService.requestComputeToData(data),
    );
    if (result) {
      return {
        jobId: result,
      };
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async GetComputeToDataStatus(
    data: ComputeToDataStatusRequest,
  ): Promise<ComputeToDataStatusResponse> {
    this.logRequest('GetComputeToDataStatus', data);
    const result = await this.runRpc('getComputeToDataStatus', () =>
      this.pontusxService.getComputeToDataStatus(data.jobId),
    );
    // 0 ("Job started") is a valid status
    if (result !== undefined && result !== null) {
      return {
        status: result,
        description: isCtdStatusCode(result)
          ? getCtdStatusText(result) + ' | ' + CtdToDcpStateMap[result]
          : `Unknown compute job status ${result}`,
      };
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }
}
