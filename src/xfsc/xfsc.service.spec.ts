import axios, { AxiosResponse } from 'axios';
import { XfscService } from './xfsc.service';

jest.mock('axios');
import {
  CreateOfferingRequest,
  CreateOfferingResponse,
} from '../generated/spp_v2';

jest.mock('axios');
describe('Xfsc service', () => {
  let xfscService = new XfscService();

  it('Token function should return a string', async () => {
    const mockResponse = {
      data: {
        access_token: 'mockToken',
      },
    };

    axios.request = jest.fn().mockResolvedValue(mockResponse);

    const token = await xfscService.getToken();

    expect(mockResponse.data.access_token).toBe(token);
  });

  it('Publish function should return ID', async () => {
    const mockVP = {
      key: 'value',
    } as unknown as JSON;

    const mockToken = 'mockToken';

    const response: AxiosResponse<JSON> = {
      data: { id: 'mockID' } as unknown as JSON,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {
        headers: undefined,
      },
    };

    axios.request = jest.fn().mockResolvedValue(response);

    const result = await xfscService.publish(mockToken, mockVP);
    expect(result).toBe('mockID');

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockToken}`,
        }),
        data: mockVP,
      }),
    );

    expect(xfscService.publish).rejects.toThrow();
  });

  it('Delete function should return the Nothing and throw an error in case of a problem', async () => {
    const mockToken = 'mockToken';
    const mockHash = 'mockHash';

    axios.request = jest.fn().mockResolvedValue(undefined);

    await xfscService.delete(mockToken, mockHash);

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockToken}`,
        }),
      }),
    );

    expect(xfscService.delete).rejects.toThrow();
  });

  it('Update Function should return the ID as well as throwing an error in case of a problem occuring', async () => {
    const mockVP = {
      key: 'value',
    } as unknown as JSON;

    const mockToken = 'mockToken';

    const mockHash = 'mockHash';

    const response: AxiosResponse<JSON> = {
      data: { id: 'mockID' } as unknown as JSON,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {
        headers: undefined,
      },
    };

    axios.request = jest.fn().mockResolvedValue(response);

    const result = await xfscService.update(mockToken, mockHash, mockVP);

    expect(result).toBe('mockID');
    expect(xfscService.update).rejects.toThrow();
  });

  it('revoke Function should return ID and throw an error in case of a problem occuring', async () => {
    const mockToken = 'mockToken';

    const mockHash = 'mockHash';

    const response: AxiosResponse<JSON> = {
      data: { id: 'mockID' } as unknown as JSON,
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {
        headers: undefined,
      },
    };

    axios.request = jest.fn().mockResolvedValue(response);

    const result = await xfscService.revoke(mockToken, mockHash);
    expect(result).toBe('mockID');
    expect(xfscService.revoke).rejects.toThrow();
  });
});
