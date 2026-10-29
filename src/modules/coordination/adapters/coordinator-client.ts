import type { TxView } from '../../coordination/domain/tx';
import { fetchJson } from '../../../shared/infra/internal-client';
import { coordinatorUnavailable, isAppError } from '../../../shared/domain/errors';

export interface CoordinatorClientOptions {
  readonly baseUrl: string;
  readonly internalToken: string;
  readonly timeoutMs: number;
}

export interface TransferRequest {
  readonly from: string;
  readonly to: string;
  readonly amount: number;
  readonly requestId: string;
  readonly requestIdForLogs: string;
  readonly clientIp: string;
}

export class CoordinatorClient {
  constructor(private readonly options: CoordinatorClientOptions) {}

  async transfer(request: TransferRequest): Promise<TxView> {
    try {
      const response = await fetchJson<TxView>(`${this.options.baseUrl}/internal/v1/transfers`, {
        method: 'POST',
        body: {
          from: request.from,
          to: request.to,
          amount: request.amount,
          requestId: request.requestId,
        },
        timeoutMs: this.options.timeoutMs,
        internalToken: this.options.internalToken,
        requestId: request.requestIdForLogs,
        clientIp: request.clientIp,
      });
      return response.body;
    } catch (error) {
      if (isAppError(error) && error.code !== 'INTERNAL_ERROR') {
        throw error;
      }
      throw coordinatorUnavailable();
    }
  }

  async status(txId: string): Promise<TxView> {
    try {
      const response = await fetchJson<TxView>(
        `${this.options.baseUrl}/internal/v1/transactions/${encodeURIComponent(txId)}`,
        {
          method: 'GET',
          timeoutMs: this.options.timeoutMs,
          internalToken: this.options.internalToken,
        },
      );
      return response.body;
    } catch (error) {
      if (isAppError(error) && error.code === 'TX_NOT_FOUND') {
        throw error;
      }
      throw coordinatorUnavailable();
    }
  }
}
