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
import { LifecycleStates } from '@deltadao/nautilus';

@Controller('grpc')
export class GrpcController {
  private readonly logger = new Logger(GrpcController.name);

  constructor(
    private readonly pontusxService: PontusxService,
    private readonly xfscService: XfscService,
  ) {}

  @GrpcMethod('serviceofferingPublisher')
  async createOffering(
    data: CreateOfferingRequest,
  ): Promise<CreateOfferingResponse> {
    this.logger.debug('grpc method CreateOffering called');
    this.logger.debug(data);

    const results = [];
    for (const offering of data.offerings) {
      if (offering.pontusxOffering !== undefined) {
        const result = await this.pontusxService.publishAsset(
          offering.pontusxOffering,
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

  @GrpcMethod('serviceofferingPublisher')
  async updateOffering(
    data: UpdateOfferingRequest,
  ): Promise<UpdateOfferingResponse> {
    this.logger.debug('grpc method UpdateOffering called');
    this.logger.debug(data);

    const ces_results: Array<string> = [];
    const results = [];
    const ids = [];
    for (const offering of data.offerings) {
      if (offering.pontusxUpdateOffering !== undefined) {
        const result = await this.pontusxService.updateOffering(offering);
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
      message: 'Internal Error',
    });
  }

  @GrpcMethod('serviceofferingPublisher')
  async updateOfferingLifecycle(
    data: UpdateOfferingLifecycleRequest,
  ): Promise<UpdateOfferingLifecycleResponse> {
    const results = [];
    const ids = [];
    for (const offering of data.offerings) {
      if (offering.pontusxUpdateOfferingLifecycle !== undefined) {
        const result = await this.pontusxService.setState(
          offering.pontusxUpdateOfferingLifecycle.did,
          offering.pontusxUpdateOfferingLifecycle
            .to as unknown as LifecycleStates, // is there a better way?
        );
        if (result) {
          results.push(result);
          ids.push(offering.pontusxUpdateOfferingLifecycle.did);
        }
      } else {
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
      message: 'Some Rpc error occured',
    });
  }

  @GrpcMethod('serviceofferingPublisher')
  async getComputeToDataResult(
    data: CreateComputeToDataResultRequest,
  ): Promise<GetComputeToDataResultResponse> {
    this.logger.debug('grpc method GetComputeToDataResult called');
    try {
      return await this.pontusxService.getComputeToDataResult(
        data.jobId,
        data.computeToDataReturnType,
        data.jobIndex,
      );
    } catch (err) {
      throw new RpcException({
        code: GrpcStatusCode.INTERNAL,
        message: err,
      });
    }
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
