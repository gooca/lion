import { Roles } from './../common/types';
import { GuildMember, Role, Collection } from 'discord.js';

export class RoleService {
  hasPermission(member: GuildMember, minRoleToRun: number) {
    let roles = member.roles;
    let highestRole = this._getHighestRole(roles);
    return highestRole > minRoleToRun;
  }

  private _getHighestRole(roles: Collection<string, Role>) {
    let highestRole = 0;

    roles.forEach((role: Role) => {
      if (role.name in Roles) {
        if (role.name === "Suspended") return -10;
        highestRole = Math.max(highestRole, Roles[role.name])
      }
    });

    return highestRole;
  }
}
