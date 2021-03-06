import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { IntervalEnum, StockDataBar } from "../../../common/interfaces/data.interface";
import { ProxyJobLog } from "../../../db/entity/proxy.job.log.entity";
import { ProxyJobLogService } from "../../../db/service/proxy.job.log.service";
import { StockDataService } from "../../../db/service/stock.data.service";
import { StockDataRetrievalJobDto } from "../../dto/request/stock-data-retrieval-job.dto";
import { StockDataRetrievalJobResponseDto } from "../../dto/response/stock-data-retrieval-job-response.dto";
import { DataProxyInterface, IDataProxyConfig } from "../proxy/data.proxy.interface";
import { DataProxyService } from "../proxy/data.proxy.service";
import { AlphaVantageAPI } from "./alphavantage.api";
import {
    alphaVantageExchange,
    alphaVantageInterval,
    AlphavantageProxyConfig,
    DataType,
    IAlphavantageAPI,
    OutputSize
} from "./alphavantage.interface";

@Injectable()
export class AlphaVantageService extends DataProxyService implements DataProxyInterface {
    private readonly _alphaVantageAPI: IAlphavantageAPI;
    private readonly ALPHA_PROXY_CONFIG: IDataProxyConfig;

    constructor(private configService: ConfigService, proxyJobLogService: ProxyJobLogService, stockDataService: StockDataService) {
        super(proxyJobLogService, stockDataService);
        this.PROXY_NAME = "AlphaVantage";
        this.API_KEY_NAME = "PROXY_APIKEY_ALPHA_VANTAGE";
        this.API_KEY = this.configService.get<string>(this.API_KEY_NAME);

        this.ALPHA_PROXY_CONFIG = new AlphavantageProxyConfig(undefined, undefined, DataType.CSV, OutputSize.Full);
        this.PROXY_CONFIG = this.ALPHA_PROXY_CONFIG;

        this._alphaVantageAPI = new AlphaVantageAPI(
            proxyJobLogService,
            this.API_KEY,
            this.ALPHA_PROXY_CONFIG.additionalConfig.preferredDataType,
            this.ALPHA_PROXY_CONFIG.additionalConfig.preferredOutputSize,
            true
        );
    }

    async pingProxyHealth(): Promise<any> {
        return await this._alphaVantageAPI.getHealth();
    }

    async retrieveStockData(stockDataRetrievalJobDto: StockDataRetrievalJobDto, jobId: number | null): Promise<StockDataRetrievalJobResponseDto> {
        Logger.log(`AlphaVantageService : retrieveStockData: stockDataRetrievalJobDto=${JSON.stringify(stockDataRetrievalJobDto)} jobId=${jobId}`);
        if (this.ALPHA_PROXY_CONFIG?.openExchanges?.includes(stockDataRetrievalJobDto.exchange)) {
            if (stockDataRetrievalJobDto.interval === IntervalEnum.ONE_DAY) {
                return await this.retrieveDailyData(stockDataRetrievalJobDto, jobId);
            } else if (this.ALPHA_PROXY_CONFIG?.intraDayIntervals?.includes(stockDataRetrievalJobDto.interval)) {
                return await this.retrieveIntraDayData(stockDataRetrievalJobDto, jobId);
            } else {
                throw new Error(`AlphaVantageService : retrieveStockData : Invalid interval='${stockDataRetrievalJobDto.interval}'`);
            }
        } else {
            throw new Error(`AlphaVantageService : retrieveStockData : Invalid exchange='${stockDataRetrievalJobDto.exchange}'`);
        }
    }

    async retrieveIntraDayData(stockDataRetrievalJobDto: StockDataRetrievalJobDto, jobId: number | null): Promise<StockDataRetrievalJobResponseDto> {
        Logger.log(`AlphaVantageService : retrieveIntraDayData: stockDataRetrievalJobDto=${JSON.stringify(stockDataRetrievalJobDto)} jobId=${jobId}`);
        const interval: number = stockDataRetrievalJobDto.interval;
        const url: string = this._alphaVantageAPI.getIntraDayDataUrl(
            stockDataRetrievalJobDto.symbol,
            alphaVantageExchange(stockDataRetrievalJobDto.exchange),
            alphaVantageInterval(interval)
        );
        await this._alphaVantageAPI
            .getIntraDayData(stockDataRetrievalJobDto.symbol, alphaVantageExchange(stockDataRetrievalJobDto.exchange), alphaVantageInterval(interval))
            .then((data: StockDataBar[]) => {
                Logger.log("AlphaVantageService : retrieveIntraDayData: success");
                this.saveStockDataToDb(stockDataRetrievalJobDto.symbol, stockDataRetrievalJobDto.exchange, interval, data)
                    .then(() => {
                        Logger.log("AlphaVantageService : saveIntraDayDataToDb: success");
                    })
                    .catch((error) => {
                        Logger.log("AlphaVantageService : saveIntraDayDataToDb: failed", error);
                    });
                this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.OK, `DataSize=${data.length}`);
            })
            .catch((error) => {
                if (error.toString().startsWith("Error:")) {
                    Logger.warn("AlphaVantageService : retrieveIntraDayData: error", error);
                    this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.BAD_REQUEST, error.toString());
                    throw new HttpException(error.toString(), HttpStatus.BAD_REQUEST);
                } else {
                    Logger.error("AlphaVantageService : retrieveIntraDayData: error", error);
                    this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.INTERNAL_SERVER_ERROR, error.toString());
                    throw new HttpException(error.toString(), HttpStatus.INTERNAL_SERVER_ERROR);
                }
            });
        const proxyJobLog: ProxyJobLog = await this.proxyJobLogService.findProxyJobLogById(jobId);
        return new StockDataRetrievalJobResponseDto(proxyJobLog);
    }

    async retrieveDailyData(stockDataRetrievalJobDto: StockDataRetrievalJobDto, jobId: number | null): Promise<StockDataRetrievalJobResponseDto> {
        Logger.log(`AlphaVantageService : retrieveDailyData: stockDataRetrievalJobDto=${JSON.stringify(stockDataRetrievalJobDto)} jobId=${jobId}`);
        const interval: number = stockDataRetrievalJobDto.interval;
        const url: string = this._alphaVantageAPI.getDailyDataUrl(
            stockDataRetrievalJobDto.symbol,
            alphaVantageExchange(stockDataRetrievalJobDto.exchange),
            alphaVantageInterval(interval)
        );
        await this._alphaVantageAPI
            .getDailyData(stockDataRetrievalJobDto.symbol, alphaVantageExchange(stockDataRetrievalJobDto.exchange), alphaVantageInterval(interval))
            .then((data: StockDataBar[]) => {
                Logger.log("AlphaVantageService : retrieveDailyData: success");
                this.saveStockDataToDb(stockDataRetrievalJobDto.symbol, stockDataRetrievalJobDto.exchange, interval, data)
                    .then(() => {
                        Logger.log("AlphaVantageService : saveDailyDataToDb: success");
                    })
                    .catch((error) => {
                        Logger.log("AlphaVantageService : saveDailyDataToDb: failed", error);
                    });
                this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.OK, `DataSize=${data.length}`);
            })
            .catch((error) => {
                if (error.toString().startsWith("Error:")) {
                    Logger.warn("AlphaVantageService : retrieveDailyData: error", error);
                    this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.BAD_REQUEST, error.toString());
                    throw new HttpException(error.toString(), HttpStatus.BAD_REQUEST);
                } else {
                    Logger.error("AlphaVantageService : retrieveDailyData: error", error);
                    this.proxyJobLogService.updateProxyJobLog(jobId, this.PROXY_NAME, url, HttpStatus.INTERNAL_SERVER_ERROR, error.toString());
                    throw new HttpException(error.toString(), HttpStatus.INTERNAL_SERVER_ERROR);
                }
            });
        const proxyJobLog: ProxyJobLog = await this.proxyJobLogService.findProxyJobLogById(jobId);
        return new StockDataRetrievalJobResponseDto(proxyJobLog);
    }
}
