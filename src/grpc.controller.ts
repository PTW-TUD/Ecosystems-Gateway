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
} from './generated/spp_v2';
import { status as GrpcStatusCode } from '@grpc/grpc-js';
import {
  extractRpcError,
  isRpcException,
  mapToRpcException,
} from './grpc-error.util';
import { LifecycleStates } from '@deltadao/nautilus';

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

  @GrpcMethod('serviceofferingPublisher')
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
  @GrpcMethod('serviceofferingPublisher')
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

  @GrpcMethod('serviceofferingPublisher')
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

  @GrpcMethod('serviceofferingPublisher')
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

  @GrpcMethod('serviceofferingPublisher')
  async getOffering(data: GetOfferingRequest): Promise<GetOfferingResponse> {
    this.logger.debug('grpc method GetOffering called');

    const result: string[] = [];
    try {
      await Promise.all(
        data.offerings.map(async (offering) => {
          if (offering.pontusxOffering) {
            const pontusxResult = await this.pontusxService.getOffering(
              offering.pontusxOffering.did,
            );
            result.push(JSON.stringify(pontusxResult));
          }

          if (offering.xfscOffering) {
            const xfscResult = await this.xfscService.getOffering(
              offering.xfscOffering.did,
              offering.xfscOffering.issuer,
              offering.xfscOffering.name,
            );
            result.push(...xfscResult);
          }
        }),
      );

      return {
        offerings: result,
        DebugInformation: [],
      };
    } catch (error) {
      throw new RpcException({
        code: GrpcStatusCode.INTERNAL,
        message: 'Seems like an error occurred',
      });
    }
  }

  @GrpcMethod('serviceofferingPublisher')
  async RunComputeToDataJob(
    data: CreateComputeToDataRequest,
  ): Promise<ComputeToDataResponse> {
    this.logger.debug('Calling RunComputeToDataJob');
    try {
      let result = await this.pontusxService.requestComputeToData(
        data.did,
        data.algorithm,
        data.userData,
      );
      return {
        jobId: result,
      };
    } catch (err) {
      throw new RpcException({
        code: GrpcStatusCode.INTERNAL,
        message: err,
      });
    }
  }
}
