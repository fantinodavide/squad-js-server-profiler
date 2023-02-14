import DiscordBasePlugin from './discord-base-plugin.js';
import TpsLogger from './tps-logger.js';
import LogParser from '../../core/log-parser/index.js';
import { MessageAttachment } from "discord.js";

import async from 'async';
import * as http from 'http';

export default class ServerProfiler extends DiscordBasePlugin {
    static get description() {
        return "Server Profiler manager plugin";
    }

    static get defaultEnabled() {
        return true;
    }

    static get optionsSpecification() {
        return {
            ...DiscordBasePlugin.optionsSpecification,
            channelID: {
                required: true,
                description: 'The ID of the channel to send logs to.',
                default: '',
                example: '667741905228136459'
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.matchProfilerLog = this.matchProfilerLog.bind(this);
        this.roundEnded = this.roundEnded.bind(this);
        this.onTpsDrop = this.onTpsDrop.bind(this);
        this.csvProfilerEnded = this.csvProfilerEnded.bind(this);
        this.profilerStart = this.profilerStart.bind(this);
        this.profilerStop = this.profilerStop.bind(this);
        this.profilerRestart = this.profilerRestart.bind(this);

        this.TpsLogger = this.server.plugins.find(p => p instanceof TpsLogger);

        this.broadcast = this.server.rcon.broadcast;
        this.warn = this.server.rcon.warn;
    }

    async profilerStart() {
        await this.server.rcon.execute('AdminProfileServerCSV start')
    }
    async profilerStop() {
        await this.server.rcon.execute('AdminProfileServerCSV stop')
    }
    async profilerRestart() {
        this.verbose(1, 'Restarting profiler')
        await this.profilerStop();
        setTimeout(this.profilerStart, 2000)
    }

    async mount() {
        this.verbose(1, 'Mounted.')
        // this.bindListeners();
        // console.log(this.server.logParser.processLine)
        this.server.on('ROUND_ENDED', this.roundEnded)
        this.server.on('TPS_DROP', this.onTpsDrop)
        // this.server.on('CSV_PROFILER_ENDED', this.csvProfilerEnded)


        // setTimeout(this.roundEnded, 2000)
    }

    async unmount() {
        this.verbose(1, 'TpsLogger unmounted');
    }

    async onTpsDrop(dt) {
        this.verbose(1, 'Detected TPS Drop', dt)
        this.server.once('CSV_PROFILER_ENDED', (info) => {
            this.verbose(1, 'CSV Profiler ENDED', info)
            this.TpsLogger.tickRates[ dt.id ].profiler_csv_path = info.groups.csv_file_path;
            // console.log(this.TpsLogger.tickRates[ dt.id ]);
            this.profilerStart();
        })
        await this.profilerStop();

    }

    async roundEnded(info) {
        await this.profilerStop();
    }

    csvProfilerEnded(dt) {
        this.verbose(1, 'CSV Profiler ENDED', dt)
        this.TpsLogger.tickRates[ dt.id ].profiler_csv_path = dt.groups.csv_file_path;
        console.log(this.TpsLogger.tickRates[ dt.id ]);
        this.profilerStart();
    }

    matchProfilerLog(line) {
        const regex = /LogCsvProfiler\: Display\: Capture (?<state>\w+)(. CSV ID: (?<csv_id>\w+))?(. Writing CSV to file : (?<csv_file_path>.+))?/
        const match = line.match(regex);
        if (match) {
            const event = `CSV_PROFILER_${match.groups.state.toUpperCase()}`;
            this.server.emit(event, match)
            this.verbose(1, 'Emitting event', event)
        }
    }
}