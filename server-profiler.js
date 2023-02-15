import DiscordBasePlugin from './discord-base-plugin.js';
import TpsLogger from './tps-logger.js';
import { MessageAttachment, WebhookClient } from "discord.js";
import Path from 'path';
import fs from 'fs';
import { createGzip } from 'zlib';
import { pipeline } from 'stream';

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
            },
            enableFileCompression: {
                required: false,
                description: '',
                default: true
            },
            discordWebhook: {
                required: false,
                description: '',
                default: null,
                example: "https://discord.com/api/webhooks/1234567890123456789/tttOOOkkkEEEnnn"
            }
        };
    }

    constructor(server, options, connectors) {
        super(server, options, connectors);

        this.matchProfilerLog = this.matchProfilerLog.bind(this);
        this.roundEnded = this.roundEnded.bind(this);
        this.onTpsDrop = this.onTpsDrop.bind(this);
        this.profilerStart = this.profilerStart.bind(this);
        this.profilerStop = this.profilerStop.bind(this);
        this.profilerRestart = this.profilerRestart.bind(this);
        this.sendDiscordCsvReport = this.sendDiscordCsvReport.bind(this);
        this.sendFileBufferToDiscord = this.sendFileBufferToDiscord.bind(this);
        this.deleteProfilerCSV = this.deleteProfilerCSV.bind(this);

        this.TpsLogger = this.server.plugins.find(p => p instanceof TpsLogger);

        this.broadcast = this.server.rcon.broadcast;
        this.warn = this.server.rcon.warn;

        this.deleteProtection = false;

        this.SquadGameDir = this.server.options.logDir.replace(/\\/g, '/').match(/(.+)(\/SquadGame\/.*)/)[ 1 ]
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
        console.log(this.channel);
        this.verbose(1, 'Mounted.')
        // this.bindListeners();
        // console.log(this.server.logParser.processLine)
        this.server.on('ROUND_ENDED', this.roundEnded)
        this.server.on('TPS_DROP', this.onTpsDrop)
        this.server.on('CSV_PROFILER_ENDED', this.deleteProfilerCSV)
        // this.server.on('CSV_PROFILER_ENDED', this.csvProfilerEnded)
        // setTimeout(() => {
        //     this.TpsLogger = this.server.plugins.find(p => p instanceof TpsLogger);
        // }, 1000)

        this.profilerRestart();
        setInterval(this.profilerRestart, 10 * 60 * 1000);

        // setTimeout(this.roundEnded, 2000)
    }

    async unmount() {
        this.verbose(1, 'TpsLogger unmounted');
    }

    async onTpsDrop(dt) {
        this.deleteProtection = true;
        this.verbose(1, 'Detected TPS Drop', dt)
        this.server.once('CSV_PROFILER_ENDED', async (info) => {
            // this.TpsLogger = this.server.plugins.find(p => p instanceof TpsLogger);

            const csvName = info.groups.csv_file_path.match(/\w+\(\d+_\d+\)\.csv/)[ 0 ];
            const csvPath = info.groups.csv_file_path.match(/SquadGame\/.+\/\w+\(\d+_\d+\)\.csv/)[ 0 ];
            const profilerPath = Path.join(this.SquadGameDir, csvPath)
            this.TpsLogger.tickRates[ dt.id ].profiler_csv_path = csvPath;
            this.verbose(1, 'CSV Profiler ENDED', profilerPath)
            this.profilerStart();

            this.sendDiscordCsvReport(profilerPath, csvName, () => {
                fs.unlink(profilerPath, () => { });
                this.deleteProtection = false;
            });
            // console.log(this.TpsLogger.tickRates[ dt.id ]);

        })
        await this.profilerStop();
    }

    async roundEnded(info) {
        await this.profilerStop();
    }

    deleteProfilerCSV(info) {
        if (this.deleteProtection) return;
        const csvPath = info.groups.csv_file_path.match(/SquadGame\/.+\/\w+\(\d+_\d+\)\.csv/)[ 0 ];
        const profilerPath = Path.join(this.SquadGameDir, csvPath)
        fs.unlink(profilerPath, () => { });
    }

    async sendDiscordCsvReport(csvPath, csvName, callback = () => { }) {
        this.verbose(1, `Sending ${csvName} in Discord channel with id: "${this.options.channelID}"`)
        const outputPath = csvPath + '.gz';

        if (this.options.enableFileCompression) {
            const gzip = createGzip();
            const source = fs.createReadStream(csvPath);
            pipeline(source, gzip,
                async (data) => {
                    try {
                        await this.sendFileBufferToDiscord(data, csvName + '.gz')
                    } catch (error) {
                        this.verbose(1, 'Could not send discord message. Error: ', error)
                    }
                    callback();
                },
                async (err) => {
                    if (err) {
                        console.error('An error occurred:', err);
                        process.exitCode = 1;
                    }
                }
            );
        } else {
            await this.sendFileBufferToDiscord(fs.readFileSync(csvPath), csvName)
            callback();
        }
    }

    sendFileBufferToDiscord(buffer, fileName) {
        let client;
        if (this.options.discordWebhook) {
            this.verbose(1, `Sending file to Discord using Webhook: ${this.options.discordWebhook}`)
            // const parsed = this.options.discordWebhook.match(/api\/webhooks\/(?<id>.+)\/(?<token>.+)/)
            // client = new WebhookClient({ id: parsed[ 1 ], token: parsed[ 2 ] });
            client = new WebhookClient({ url: this.options.discordWebhook });
        } else {
            this.verbose(1, `Sending file to Discord channel: ${this.options.channelID}`)
            client = this.channel;
        }

        return client.send({
            files: [
                new MessageAttachment(buffer, fileName)
            ]
        })
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