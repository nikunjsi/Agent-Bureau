import { z } from 'zod';
import { CompanySchema } from '../../models/company';
import { DepartmentSchema } from '../../models/department';
import { EmployeeSchema } from '../../models/employee';
import { IdSchema } from '../../models/ids';
import { EmptyInputSchema, IdInputSchema, OkOutputSchema, listOutputSchema, nullableGetOutputSchema } from './common';

export const Company = {
  get: { input: EmptyInputSchema, output: nullableGetOutputSchema(CompanySchema) },
  update: {
    input: z.object({ name: z.string().min(1).optional(), homePath: z.string().min(1).optional() }),
    output: z.object({ item: CompanySchema }),
  },
  hire: {
    input: z.object({ roleKey: z.string().min(1), name: z.string().min(1).optional() }),
    output: z.object({ item: EmployeeSchema }),
  },
  fire: { input: IdInputSchema, output: OkOutputSchema },
  rename: { input: z.object({ id: IdSchema, name: z.string().min(1) }), output: OkOutputSchema },
  moveDesk: { input: z.object({ id: IdSchema, deskX: z.number().int(), deskY: z.number().int() }), output: OkOutputSchema },
  listDepartments: { input: EmptyInputSchema, output: listOutputSchema(DepartmentSchema) },
  addDepartment: {
    input: z.object({ key: z.string().min(1), name: z.string().min(1) }),
    output: z.object({ item: DepartmentSchema }),
  },
  removeDepartment: { input: IdInputSchema, output: OkOutputSchema },
};
