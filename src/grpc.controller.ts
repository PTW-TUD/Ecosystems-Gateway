import { Controller, Logger } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { PontusxService } from './pontusx/pontusx.service';
import { XfscService } from './xfsc/xfsc.service';
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
} from './generated/spp_v2';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import {
  extractRpcError,
  isRpcException,
  mapToRpcException,
} from './grpc-error.util';
import { LifecycleStates } from '@deltadao/nautilus';
import {
  CtdStatusCode,
  CtdStatusMap,
  CtdToDcpStateMap,
} from './pontusx/utility';

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
      const ms = Date.now() - start;
      // Pass-through if already RpcException
      if (isRpcException(err)) {
        const p = extractRpcError(err);
        const codeName = p.code != null ? GrpcStatusCode[p.code] : 'UNKNOWN';
        this.logger.error(
          `[${method}] ✗ RpcException ${codeName} in ${ms}ms: ${p.message}`,
          err?.stack,
        );
        throw err;
      }
      // Map unknown errors
      const mapped = mapToRpcException(err, {
        service: 'grpc.controller',
        where: method,
        defaultCode: GrpcStatusCode.INTERNAL,
      });
      const p = extractRpcError(mapped);
      this.logger.error(
        `[${method}] ✗ mapped in ${ms}ms: ${p.message}`,
        err?.stack,
      );
      throw mapped;
    }
  }

  @GrpcMethod('ecosystemsgateway')
  async createOffering(
    data: CreateOfferingRequest,
  ): Promise<CreateOfferingResponse> {
    this.logger.debug('grpc method CreateOffering called');
    this.logger.verbose(data);

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
          const VP = JSON.parse(offering.xfscOffering.VP);
          const token = await this.xfscService.getToken();
          const singleResult = await this.xfscService.publish(
            token,
            (data = VP),
          );
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
        DebugInformation: undefined,
      };
    }
  }

  // TODO: always use runRpc with pontusxService
  @GrpcMethod('ecosystemsgateway')
  async updateOffering(
    data: UpdateOfferingRequest,
  ): Promise<UpdateOfferingResponse> {
    this.logger.debug('grpc method UpdateOffering called');
    this.logger.verbose(data);

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
        const VP = JSON.parse(offering.xfscUpdateOffering.VP);

        const result = await this.xfscService.update(token, hash, VP);

        return {
          id: [result],
          locations: undefined,
          DebugInformation: undefined,
        };
      }
    }

    if (ces_results.length || results.length) {
      return {
        id: results,
        locations: ces_results,
        DebugInformation: { results },
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
    this.logger.debug('grpc method UpdateOfferingLifecycle called');
    this.logger.verbose(data);
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
        DebugInformation: { results },
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
    this.logger.debug('grpc method GetComputeToDataResult called');
    this.logger.verbose(data);
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
    this.logger.debug('grpc method GetOffering called');
    this.logger.verbose(data);

    const result: string[] = [];
    await Promise.all(
      data.offerings.map(async (offering) => {
        if (offering.pontusxOffering) {
          const pontusxResult = await this.runRpc('getPontusxOffering', () =>
            this.pontusxService.getOffering(offering.pontusxOffering.did),
          );
          if (pontusxResult) {
            result.push(JSON.stringify(pontusxResult));
          }
        }

        if (offering.xfscOffering) {
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
        DebugInformation: [],
      };
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }

  @GrpcMethod('ecosystemsgateway')
  async AccessService(
    data: AccessServiceRequest,
  ): Promise<AccessServiceResponse> {
    this.logger.debug('grpc method AccessService called');
    this.logger.verbose(data);
    let result = await this.runRpc('accessService', () =>
      this.pontusxService.accessService(
        data.did,
        data.serviceId,
        data.fileIndex,
        data.userdata,
      ),
    );
    if (result) {
      return {
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
    this.logger.debug('grpc method RunComputeToDataJob called');
    this.logger.verbose(data);
    let result = await this.runRpc('requestComputeToData', () =>
      this.pontusxService.requestComputeToData(
        data.did,
        data.algorithm,
        data.userdata,
      ),
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
    this.logger.debug('grpc method RunComputeToDataJob called');
    this.logger.verbose(data);
    let result = await this.runRpc('getComputeToDataStatus', () =>
      this.pontusxService.getComputeToDataStatus(data.jobId),
    );
    if (result) {
      if (result in CtdStatusMap) {
        return {
          status: result as CtdStatusCode,
          description:
            CtdStatusMap[result as CtdStatusCode] +
            ' | ' +
            CtdToDcpStateMap[result as CtdStatusCode],
        };
      }
      throw new RpcException({
        code: GrpcStatusCode.NOT_FOUND,
        message: `Compute Job couldn't be found`,
      });
    }
    throw new RpcException({
      code: GrpcStatusCode.INTERNAL,
      message: 'Internal error - no results',
    });
  }
}
