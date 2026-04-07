import axios, { AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import * as qs from 'qs';

import {
  XFSC_USERNAME,
  XFSC_PASSWORD,
  XFSC_CAT_HOST_SD_ENDPOINT,
  XFSC_CAT_TOKEN_ENDPOINT,
  CLIENT_SECRET,
  CLIENT_ID,
} from './config';

export class XfscService {
  private readonly username: string;
  private readonly password: string;
  private readonly client_secret: string;
  private readonly client_id: string;
  private readonly xfscCatAddr: string;
  private readonly xfscTokenEndpoint: string;
  private readonly logger: Logger;

  constructor() {
    this.logger = new Logger(XfscService.name);
    this.username = XFSC_USERNAME;
    this.password = XFSC_PASSWORD;

    this.client_id = CLIENT_ID;
    this.client_secret = CLIENT_SECRET;

    this.xfscCatAddr = XFSC_CAT_HOST_SD_ENDPOINT;
    this.xfscTokenEndpoint = XFSC_CAT_TOKEN_ENDPOINT;
  }

  async publish(token: string, VP: JSON): Promise<string> {
    // returns ID
    let response: AxiosResponse<JSON>;

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: this.xfscCatAddr,
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      data: VP,
    };

    this.logger.log('Publishing in XFSC CAT ...');
    try {
      response = await axios.request(config);
      this.logger.log('Successfully published in XFSC CAT.');
      this.logger.debug(response.data);
      return response.data['id'];
    } catch (error) {
      this.logger.error(
        'Error occurred while trying to Publish VP to XFSC Cat.',
      );

      this.logger.debug({ err: error?.response?.status });

      if (error?.response?.status == 409) {
        return;
      }

      this.handleError(error);
    }
  }

  async update(token: string, hash: string, VP: JSON): Promise<string> {
    // returns ID

    this.delete(token, hash);

    const id: string = await this.publish(token, VP); // Publish function already returns the SD's ID
    this.logger.log('Published updated SD successfully.');

    return id;
  }

  async delete(token: string, hash: string): Promise<void> {
    // returns nothing, because there's no body in the Cat's response

    const config = {
      method: 'delete',
      maxBodyLength: Infinity,
      url: this.xfscCatAddr + hash,
      headers: {
        accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
    };

    try {
      await axios.request(config);

      this.logger.log('Successfully deleted SD with hash: ', hash);
    } catch (error) {
      this.logger.error(
        'Error occured while trying to delete SD with hash: ',
        hash,
      );

      this.handleError(error);
    }
  }

  async revoke(token: string, hash: string): Promise<string> {
    // returns ID

    let response: AxiosResponse<JSON>;

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: this.xfscCatAddr + hash + '/revoke',
      headers: {
        accept: 'application/json',
        Authorization: 'Bearer ' + token,
      },
    };

    try {
      response = await axios.request(config);

      this.logger.log('Successfully revoked SD (${hash}).');

      return response.data['id'];
    } catch (error) {
      this.logger.error('Error occurred while processing the request: ');

      throw error;
    }
  }

  async getOffering(
    did: string,
    author: string,
    name: string,
  ): Promise<string[]> {
    void name;
    const token = this.getToken();
    const RequestConfig: AxiosRequestConfig = {
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    };

    const searchParams = new URLSearchParams({});
    if (did) {
      searchParams.set('id', did);

      if (author) {
        searchParams.set('issuer', author);
      }

      try {
        const response = await axios.get(
          `/self-descriptions?${searchParams.toString()}`,
          RequestConfig,
        );

        const resp = JSON.parse(response.data);
        if (resp.items) {
          return [resp.items[0].content];
        }
        return [];
      } catch {
        // FIXME
        return undefined;
      }
    } else {
      searchParams.set('offset', '0');
      searchParams.set('withContent', 'true');
      searchParams.set('withMeta', 'false');
      searchParams.set('limit', '1000');
      try {
        const response = await axios.get(
          `/self-descriptions?${searchParams.toString()}`,
          RequestConfig,
        );

        const resp = JSON.parse(response.data);
        const found_items = [];
        resp.items.forEach((item) => {
          found_items.push(item.content);
        });
        return [];
      } catch {
        // FIXME
        return undefined;
      }
    }
  }

  async getToken(): Promise<string> {
    const data = qs.stringify({
      grant_type: 'password', // 'client_credentials' flow is not suitable, because of a lack of keycloak configurations in terms of the client's roles, which would cause a 403 forbidden status Code
      username: this.username,
      password: this.password,
      client_id: this.client_id,
      scope: 'openid',
      client_secret: this.client_secret,
    });

    const config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: this.xfscTokenEndpoint,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: data,
    };

    try {
      const response: JSON = await axios.request(config);

      return response['data']['access_token'];
    } catch (error) {
      this.logger.error('Error occured while requesting the token.');

      this.handleError(error);
    }
  }

  handleError(error): void {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      console.error('Error message:', axiosError.message);

      if (axiosError.response) {
        this.logger.error('Status code:', axiosError.response.status);
        this.logger.error('Response data:', axiosError.response.data);
        this.logger.error('Response headers:', axiosError.response.headers);
      } else if (axiosError.request) {
        this.logger.error('Request:', axiosError.request);
      } else {
        this.logger.error('Error', axiosError.message);
      }
      throw new HttpException('Error', HttpStatus.BAD_GATEWAY);
    } else {
      this.logger.error('Non-Axios error occurred: ', error);
      throw new HttpException('Error', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
