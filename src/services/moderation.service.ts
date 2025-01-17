import { Guild, Snowflake, RichEmbed, GuildChannel } from 'discord.js';
import { StorageService } from './storage.service';
import { ObjectId } from 'mongodb';
import Environment from '../environment';
import { ClientService } from './client.service';
import { GuildService } from './guild.service';
import { LoggerService } from './logger.service';

export namespace Moderation {
  export namespace Helpers {
    export function resolveUser(guild: Guild, user: string): Snowflake | undefined {
      try {
        return guild.members.find((gm) => gm.user.tag === user).user.id;
      } catch (_) {
        return undefined;
      }
    }

    export function serialiseReportForMessage(report: Report): string {
      const attachments =
        (report.attachments && report.attachments.length && report.attachments.join(', ')) ||
        'no attachment';
      return `\`${report.description || 'no description'}\`: [${attachments}] at ${new Date(
        report.timeStr
      ).toLocaleString('en-US')}`;
    }
  }

  export interface IModerationReport {
    guild: Snowflake;
    user: Snowflake;
    description?: string;
    attachments?: string[];
    timeStr: string;
    _id?: ObjectId;
  }

  export interface IModerationBan {
    user: Snowflake;
    guild: Snowflake;
    date: Date;
    active: boolean;
    reason: string;
    reportId?: ObjectId;
    _id: ObjectId;
  }

  export interface IModerationWarning {
    user: Snowflake;
    guild: Snowflake;
    date: Date;
    reportId?: ObjectId;
    _id: ObjectId;
  }

  export class Report implements IModerationReport {
    public guild: Snowflake;
    public user: Snowflake;
    public description?: string;
    public attachments?: string[];
    public timeStr: string;

    constructor(guild: Guild, user: string, description?: string, attachments?: string[]) {
      this.guild = guild.id;

      const found_user = Helpers.resolveUser(guild, user);

      if (!found_user) {
        throw `Could not resolve ${user} to a user`;
      }

      this.user = found_user;

      this.description = description;
      this.attachments = attachments;

      const has_desc = this.description && this.description.length;
      const has_atta = this.attachments && this.attachments.length;

      if (!has_desc && !has_atta) {
        throw `Need either a description or attachment(s).`;
      }

      this.timeStr = new Date().toISOString();
    }

    public toString(): string {
      return Helpers.serialiseReportForMessage(this);
    }
  }
}

export class ModService {
  constructor(
    private _storageService: StorageService,
    private _clientService: ClientService,
    private _guildService: GuildService,
    private _loggerService: LoggerService
  ) {}

  // Files a report but does not warn the subject.
  public async fileReport(report: Moderation.Report): Promise<string> {
    const res = await this._insertReport(report);
    if (res) {
      return `Added report: ${Moderation.Helpers.serialiseReportForMessage(report)}`;
    } else {
      return `Could not insert report.`;
    }
  }

  // Files a report and warns the subject.
  public async fileWarning(report: Moderation.Report): Promise<string> {
    const fileReportResult: Promise<ObjectId | undefined> = this._insertReport(report);

    const warnings = (await this._storageService.getCollections()).modwarnings;

    const recentWarnings =
      (await warnings
        ?.find({ user: report.user, guild: report.guild })
        .sort({ date: -1 })
        .limit(Environment.WarningsThresh)
        .toArray()) || [];

    const beginningOfWarningRange = new Date();
    beginningOfWarningRange.setDate(beginningOfWarningRange.getDate() - Environment.WarningsRange);

    const shouldEscalateToBan =
      recentWarnings.length >= Environment.WarningsThresh &&
      recentWarnings.reduce((acc, x) => acc && x.date >= beginningOfWarningRange, true);

    if (shouldEscalateToBan) {
      this.fileBan(report);
      return `User has been warned too many times. Escalate to ban.`;
    }

    await warnings?.insertOne({
      user: report.user,
      guild: report.guild,
      date: new Date(),
      reportId: await fileReportResult,
    });

    this._sendModMessageToUser('A warning has been issued. ', report);
    return `User warned: ${Moderation.Helpers.serialiseReportForMessage(report)}`;
  }

  // Files a report and bans the subject.
  public async fileBan(report: Moderation.Report) {
    if (await this._isUserCurrentlyBanned(report.guild, report.user)) {
      return `User is already banned.`;
    }

    const bans = (await this._storageService.getCollections())?.modbans;

    await bans?.insertOne({
      guild: report.guild,
      user: report.user,
      date: new Date(),
      active: true,
      reason: report.description || '<none>',
      reportId: await this._insertReport(report),
    });

    try {
      await this._guildService.get().ban(report.user, { reason: report.description });
    } catch (e) {
      return 'Issue occurred trying to ban user.';
    }

    return `Banned User`;
  }

  // Produces a report summary.
  // TODO: add warnings and bans metrics.
  public async getModerationSummary(guild: Guild, user_handle: string): Promise<RichEmbed> {
    const collections = await this._storageService.getCollections();
    const user = Moderation.Helpers.resolveUser(guild, user_handle);

    const modreports = collections?.modreports;
    const modwarnings = collections?.modwarnings;
    const modbans = collections?.modbans;

    const reports = await modreports?.find({ guild: guild.id, user });
    const warnings = await modwarnings?.find({ guild: guild.id, user });
    const bans = await modbans?.find({ guild: guild.id, user });

    const mostRecentBan =
      (await bans
        ?.sort({ date: -1 })
        .limit(1)
        .toArray()) || [];

    let banStatus = '';
    if (mostRecentBan.length && mostRecentBan[0].active) {
      banStatus = `Banned since ${mostRecentBan[0].date.toLocaleString()}`;
    } else {
      banStatus = 'Not banned';
    }

    const mostRecentWarning =
      (await warnings
        ?.sort({ date: -1 })
        .limit(1)
        .toArray()) || [];

    let lastWarning = '<none>';
    if (mostRecentWarning.length) {
      const _id = mostRecentWarning[0].reportId;
      const rep = await modreports?.findOne({ _id });
      if (rep) {
        lastWarning = Moderation.Helpers.serialiseReportForMessage(rep);
      }
    }

    const reply = new RichEmbed();

    reply.setTitle('Moderation Summary on ' + user_handle);

    reply.addField('Total Reports', await reports?.count());
    reply.addField('Total Warnings', await warnings?.count());
    reply.addField('Ban Status', banStatus);
    reply.addField('Last warning', lastWarning);

    reply.setTimestamp(new Date());
    reply.setColor('#ff3300');

    return reply;
  }

  public async checkForScheduledUnBans() {
    this._loggerService.info('Running UnBan');

    const modbans = (await this._storageService.getCollections())?.modbans;

    if (!modbans) {
      this._loggerService.info('No modbans DB. Skipping this run of checkForScheduledUnBans');
      return;
    }

    const guild = this._guildService.get();
    const bulk = modbans.initializeUnorderedBulkOp();

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    try {
      const unbans = await modbans
        .find({
          guild: guild.id,
          active: true,
          date: { $lte: new Date(sevenDaysAgo.toISOString()) },
        })
        .map(async (ban) => {
          this._loggerService.info('Unbanning user ' + ban.user);
          try {
            await guild.unban(ban.user);
          } catch (e) {
            this._loggerService.error('Failed to unban user ' + ban.user, e);
          }
          bulk.find({ _id: ban._id }).updateOne({ $set: { active: false } });
        })
        .toArray();

      await Promise.all(unbans);

      if (unbans.length == 0) {
        this._loggerService.info('No UnBans to perform.');
        return;
      }

      await bulk.execute();
    } catch (e) {
      this._loggerService.error(e);
    }
  }

  /// Bans the user from reading/sending
  /// in specified channels.
  /// Files a report about it.
  public async channelBan(
    guild: Guild,
    username: string,
    channels: GuildChannel[]
  ): Promise<GuildChannel[]> {
    const uid = Moderation.Helpers.resolveUser(guild, username);
    const successfulBanChannelList: GuildChannel[] = [];

    if (!uid) {
      this._loggerService.error(`Failed to resolve ${username} to a user.`);
      return successfulBanChannelList;
    }

    const channelBanPromises = channels.reduce((acc, channel) => {
      this._loggerService.debug(`Taking channel permissions away in ${channel.name}`);
      acc.push(
        channel
          .overwritePermissions(uid, { READ_MESSAGES: false, SEND_MESSAGES: false })
          .then(() => successfulBanChannelList.push(channel))
          .catch((ex) => {
            this._loggerService.error(
              `Failed to adjust permissions for ${username} in ${channel.name}`,
              ex
            );
          })
      );
      return acc;
    }, [] as Promise<void | number>[]);

    await Promise.all(channelBanPromises);

    try {
      this._insertReport(
        new Moderation.Report(
          guild,
          username,
          `Took channel permissions away in ${successfulBanChannelList
            .map((c) => c.name)
            .join(', ')}`
        )
      );
    } catch (ex) {
      this._loggerService.error('Failed to add report about channel ban.', ex);
    }

    return successfulBanChannelList;
  }

  private async _insertReport(report: Moderation.Report): Promise<ObjectId | undefined> {
    return (await (await this._storageService.getCollections())?.modreports?.insertOne(report))
      ?.ops[0]._id;
  }

  private async _isUserCurrentlyBanned(guild: Snowflake, user: Snowflake) {
    const bans = (await this._storageService.getCollections())?.modbans;

    const userBan = await bans?.findOne({ guild, user, active: true });

    return userBan?.active;
  }

  private async _sendModMessageToUser(message: string, rep: Moderation.Report) {
    await this._clientService.users
      .get(rep.user)
      ?.send(`${message} Reason: ${rep.description || '<none>'}`, {
        files: rep.attachments && JSON.parse(JSON.stringify(rep.attachments)),
      });
  }
}
