import DiscordBasePlugin from './discord-base-plugin.js';
import SocketIOAPI from './socket-io-api.js';
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

        this.broadcast = this.server.rcon.broadcast;
        this.warn = this.server.rcon.warn;
    }

    async mount() {
        // this.bindListeners();
        // console.log(this.server.logParser.processLine)
        this.httpServer();

        this.server.on('TICK_RATE', this.tickRateUpdated)
        this.server.on('ROUND_ENDED', this.roundEnded)
        this.server.on('TPS_DROP', this.onTpsDrop)

        // setTimeout(this.roundEnded, 2000)
    }

    async unmount() {
        this.verbose(1, 'TpsLogger unmounted');
    }

    onTpsDrop(dt) {
        this.verbose(1, 'Detected TPS Drop', dt)
        
    }

    async roundEnded(info) {
        await this.sendDiscordMessage({
            embed: {
                title: `TPS Logs`,
                fields: [
                    {
                        name: 'LayerID',
                        value: this.tickRates[ this.getLatestTpsRecord() ].layer,
                        inline: false
                    },
                ]
            },
            timestamp: (new Date()).toISOString()
        });
        await this.sendDiscordMessage({
            files: [
                new MessageAttachment(Buffer.from(JSON.stringify(this.tickRates, null, 2)), 'TPS_History.json')
            ]
        })
        this.tickRates = [];
    }

    matchProfilerLog(line) {
        const regex = /LogCsvProfiler\: Display\: Capture (?<state>\w+)(. CSV ID: (?<csv_id>\w+))?(. Writing CSV to file : (?<csv_file_path>.+))?/
        const match = line.match(regex);
        if (match) {
            this.server.emit(`CSV_PROFILER_${match.groups.state.toUpperCase()}`, match)
        }
    }
}