import { describe, it, expect, vi } from 'vitest';
import axios, { AxiosResponse } from 'axios';
import { XfscService } from './xfsc.service.js';

import {
  CreateOfferingRequest,
  CreateOfferingResponse,
} from '../generated/spp_v3.js';

describe('Xfsc service', () => {
  const xfscService = new XfscService();

  it('Token function should return a string', async () => {
    const mockResponse = {
      data: {
        access_token: 'mockToken',
      },
    };

    axios.request = vi.fn().mockResolvedValue(mockResponse);

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

    axios.request = vi.fn().mockResolvedValue(response);

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

    axios.request = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(xfscService.publish(mockToken, mockVP)).rejects.toThrow();
  });

  it('Delete function should return the Nothing and throw an error in case of a problem', async () => {
    const mockToken = 'mockToken';
    const mockHash = 'mockHash';

    axios.request = vi.fn().mockResolvedValue(undefined);

    await xfscService.delete(mockToken, mockHash);

    expect(axios.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockToken}`,
        }),
      }),
    );

    axios.request = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(xfscService.delete(mockToken, mockHash)).rejects.toThrow();
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

    axios.request = vi.fn().mockResolvedValue(response);

    const result = await xfscService.update(mockToken, mockHash, mockVP);

    expect(result).toBe('mockID');

    axios.request = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(
      xfscService.update(mockToken, mockHash, mockVP),
    ).rejects.toThrow();
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

    axios.request = vi.fn().mockResolvedValue(response);

    const result = await xfscService.revoke(mockToken, mockHash);
    expect(result).toBe('mockID');

    axios.request = vi.fn().mockRejectedValue(new Error('unreachable'));
    await expect(xfscService.revoke(mockToken, mockHash)).rejects.toThrow();
  });
});
